import type { Fingerprint, RecordedEvent } from "./events.js";

/** A user-level action merged from one or more raw events. */
type StepBase = {
  id: string;
  tabId: number;
  url: string;
  title?: string;
  ts: number;
  /** Indexes into the recording's events, for screenshots and page inventories. */
  events: number[];
};

export type SemanticStep =
  | (StepBase & { kind: "openTab"; openedBy?: string })
  | (StepBase & { kind: "switchTab"; initial?: boolean })
  | (StepBase & { kind: "navigate"; transition?: string })
  | (StepBase & { kind: "click"; target: Fingerprint })
  | (StepBase & { kind: "fill"; target: Fingerprint; value: string; masked: boolean; fromStep?: string })
  | (StepBase & { kind: "press"; key: string; target: Fingerprint })
  | (StepBase & { kind: "copy"; value: string; target?: Fingerprint })
  | (StepBase & { kind: "submit"; target: Fingerprint });

/** Navigations within this window after an action on the same tab are treated as its consequence. */
const CONSEQUENCE_MS = 5000;
const COPY_AFTER_CLICK_MS = 1500;
const SUBMIT_AFTER_ACTION_MS = 1000;

const ACTION_KINDS = new Set(["click", "press", "submit", "fill", "copy"]);
const CONSEQUENCE_TRANSITIONS = new Set(["link", "form_submit"]);

export function sameTarget(a?: Fingerprint, b?: Fingerprint): boolean {
  if (!a || !b) return false;
  if (a.xpath && b.xpath) return a.xpath === b.xpath;
  return Boolean(a.css && a.css === b.css);
}

export function mergeEvents(recorded: RecordedEvent[]): SemanticStep[] {
  const order = recorded.map((_, i) => i).sort((a, b) => recorded[a].event.ts - recorded[b].event.ts);
  const steps: SemanticStep[] = [];
  let counter = 0;
  const nextId = () => `s${++counter}`;
  const last = () => steps[steps.length - 1];
  const lastOnTab = (tabId: number) => [...steps].reverse().find((s) => s.tabId === tabId);

  for (const idx of order) {
    const ev = recorded[idx].event;
    const base = { tabId: ev.tabId, url: ev.url, title: ev.title, ts: ev.ts, events: [idx] };
    const prev = last();

    switch (ev.type) {
      case "tabCreated": {
        const opener = prev?.kind === "click" && prev.tabId === ev.openerTabId && ev.ts - prev.ts < CONSEQUENCE_MS ? prev.id : undefined;
        steps.push({ ...base, id: nextId(), kind: "openTab", openedBy: opener });
        break;
      }
      case "tabActivated": {
        if (prev?.kind === "openTab" && prev.tabId === ev.tabId) prev.events.push(idx);
        else if (prev && prev.tabId === ev.tabId) {
          // Already on this tab; nothing changed.
        } else steps.push({ ...base, id: nextId(), kind: "switchTab", initial: steps.length === 0 || undefined });
        break;
      }
      case "navigate": {
        const onTab = lastOnTab(ev.tabId);
        const qualifiers = ev.transitionQualifiers ?? [];
        const isRedirect = qualifiers.some((q) => q.endsWith("redirect"));
        if (onTab?.kind === "openTab" && onTab === prev) {
          // A new tab's first commit just tells us where it landed.
          onTab.url = ev.url;
          onTab.events.push(idx);
        } else if (onTab && isRedirect && ev.ts - onTab.ts < CONSEQUENCE_MS) {
          onTab.events.push(idx);
          if (onTab.kind === "navigate") onTab.url = ev.url;
        } else if (
          onTab &&
          ACTION_KINDS.has(onTab.kind) &&
          CONSEQUENCE_TRANSITIONS.has(ev.transitionType ?? "link") &&
          ev.ts - onTab.ts < CONSEQUENCE_MS
        ) {
          onTab.events.push(idx);
        } else {
          steps.push({ ...base, id: nextId(), kind: "navigate", transition: ev.transitionType });
        }
        break;
      }
      case "click":
        steps.push({ ...base, id: nextId(), kind: "click", target: ev.target });
        break;
      case "paste":
      case "input": {
        const pasted = ev.type === "paste";
        if (prev?.kind === "fill" && prev.tabId === ev.tabId && sameTarget(prev.target, ev.target)) {
          prev.value = ev.value;
          prev.events.push(idx);
          if (prev.fromStep && !ev.value.includes(copiedValue(steps, prev.fromStep) ?? "\0")) prev.fromStep = undefined;
          break;
        }
        const fill = {
          kind: "fill" as const,
          target: ev.target,
          value: ev.value,
          masked: ev.type === "input" && ev.masked,
          fromStep: pasted ? findCopy(steps, ev.value) : undefined,
        };
        // Clicking a field and then typing into it is one "fill" action.
        if (prev?.kind === "click" && prev.tabId === ev.tabId && sameTarget(prev.target, ev.target)) {
          steps[steps.length - 1] = { ...prev, ...fill, events: [...prev.events, idx] };
        } else steps.push({ ...base, id: nextId(), ...fill });
        break;
      }
      case "copy": {
        // "Click Copy" + clipboard write is one step: copy via that button.
        if (prev?.kind === "click" && prev.tabId === ev.tabId && ev.ts - prev.ts < COPY_AFTER_CLICK_MS) {
          steps[steps.length - 1] = { ...prev, kind: "copy", value: ev.value, events: [...prev.events, idx] };
        } else if (prev?.kind === "copy" && prev.value === ev.value) {
          prev.events.push(idx);
        } else steps.push({ ...base, id: nextId(), kind: "copy", value: ev.value, target: ev.target });
        break;
      }
      case "keydown":
        steps.push({ ...base, id: nextId(), kind: "press", key: ev.key, target: ev.target });
        break;
      case "submit": {
        if (
          prev &&
          (prev.kind === "click" || prev.kind === "press") &&
          prev.tabId === ev.tabId &&
          ev.ts - prev.ts < SUBMIT_AFTER_ACTION_MS
        ) {
          prev.events.push(idx);
        } else steps.push({ ...base, id: nextId(), kind: "submit", target: ev.target });
        break;
      }
    }
  }
  return steps;
}

function findCopy(steps: SemanticStep[], value: string): string | undefined {
  const v = value.trim();
  return [...steps].reverse().find((s) => s.kind === "copy" && s.value.trim() === v)?.id;
}

function copiedValue(steps: SemanticStep[], id: string): string | undefined {
  const s = steps.find((x) => x.id === id);
  return s?.kind === "copy" ? s.value.trim() : undefined;
}

function truncate(s: string, n = 50) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return truncate(u.host + (u.pathname === "/" ? "" : u.pathname), 60);
  } catch {
    return truncate(url, 60);
  }
}

export function describeTarget(t?: Fingerprint): string {
  if (!t) return "element";
  const name = t.name ?? t.text;
  const role = t.role ?? "element";
  return name ? `${role} "${truncate(name, 40)}"` : role;
}

export function describeStep(s: SemanticStep): string {
  switch (s.kind) {
    case "openTab":
      return `Open new tab at ${shortUrl(s.url)}${s.openedBy ? ` (from ${s.openedBy})` : ""}`;
    case "switchTab":
      return s.initial ? `Start on ${shortUrl(s.url)}` : `Switch to tab ${shortUrl(s.url)}`;
    case "navigate":
      return `Go to ${shortUrl(s.url)}`;
    case "click":
      return `Click ${describeTarget(s.target)}`;
    case "fill":
      if (s.masked) return `Fill ${describeTarget(s.target)} (hidden value)`;
      return `Fill ${describeTarget(s.target)} with "${truncate(s.value)}"${s.fromStep ? ` (copied in ${s.fromStep})` : ""}`;
    case "press":
      return `Press ${s.key} in ${describeTarget(s.target)}`;
    case "copy":
      return `Copy "${truncate(s.value)}"${s.target ? ` via ${describeTarget(s.target)}` : ""}`;
    case "submit":
      return `Submit form ${describeTarget(s.target)}`;
  }
}
