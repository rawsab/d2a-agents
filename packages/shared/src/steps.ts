import type { Effect, Fingerprint, RecordedEvent } from "./events.js";

/** Why a step looks unintended. Steps are flagged, never dropped; the user can override. */
export type Noise = { rule: string; reason: string; confidence: number };

/** A user-level action merged from one or more raw events. */
type StepBase = {
  id: string;
  tabId: number;
  url: string;
  title?: string;
  ts: number;
  /** Indexes into the recording's events, for screenshots and page inventories. */
  events: number[];
  /** What the step's action changed on the page, when measured. */
  effect?: Effect;
  noise?: Noise;
  /** The user marked this step as intended, overriding any noise flag. */
  keptByUser?: boolean;
};

export type SemanticStep =
  | (StepBase & { kind: "openTab"; openedBy?: string })
  | (StepBase & { kind: "switchTab"; initial?: boolean })
  | (StepBase & { kind: "navigate"; transition?: string; back?: boolean })
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

/**
 * Merges raw events into semantic steps and flags likely noise.
 * `overrides` maps a step's first event index to the user's decision (true = noise, false = keep).
 */
export function mergeEvents(recorded: RecordedEvent[], overrides: Record<string, boolean> = {}): SemanticStep[] {
  const steps = mergeRaw(recorded);
  annotateNoise(steps, recorded);
  for (const step of steps) {
    const decision = overrides[String(step.events[0])];
    if (decision === true) step.noise = { rule: "user", reason: "marked as noise by you", confidence: 1 };
    if (decision === false) {
      step.noise = undefined;
      step.keptByUser = true;
    }
  }
  return steps;
}

function mergeRaw(recorded: RecordedEvent[]): SemanticStep[] {
  const order = recorded.map((_, i) => i).sort((a, b) => recorded[a].event.ts - recorded[b].event.ts);
  const steps: SemanticStep[] = [];
  let counter = 0;
  const nextId = () => `s${++counter}`;
  const last = () => steps[steps.length - 1];
  const lastOnTab = (tabId: number) => [...steps].reverse().find((s) => s.tabId === tabId);

  /** Action id → its event index; steps can be replaced (click → fill/copy), so resolve lazily. */
  const actionIndex = new Map<string, number>();

  for (const idx of order) {
    const ev = recorded[idx].event;
    if (ev.type === "effect") {
      const actionIdx = actionIndex.get(ev.actionId);
      const step = actionIdx === undefined ? undefined : steps.find((s) => s.events.includes(actionIdx));
      if (step) {
        step.events.push(idx);
        step.effect ??= ev.effect;
      }
      continue;
    }
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
        const isBack = qualifiers.includes("forward_back");
        if (onTab?.kind === "openTab" && onTab === prev) {
          // A new tab's first commit just tells us where it landed.
          onTab.url = ev.url;
          onTab.events.push(idx);
        } else if (onTab && isRedirect && ev.ts - onTab.ts < CONSEQUENCE_MS) {
          onTab.events.push(idx);
          if (onTab.kind === "navigate") onTab.url = ev.url;
        } else if (
          onTab &&
          !isBack &&
          ACTION_KINDS.has(onTab.kind) &&
          CONSEQUENCE_TRANSITIONS.has(ev.transitionType ?? "link") &&
          ev.ts - onTab.ts < CONSEQUENCE_MS
        ) {
          onTab.events.push(idx);
        } else {
          steps.push({ ...base, id: nextId(), kind: "navigate", transition: ev.transitionType, back: isBack || undefined });
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
    if (ev.id) actionIndex.set(ev.id, idx);
  }
  return steps;
}

const REPEAT_CLICK_MS = 600;

/**
 * Activity after an action counts as caused by it if the page was quiet before (any change),
 * or, on a busy page (e.g. a playing video), if it clearly exceeds the baseline.
 * Missing real steps is worse than missing noise, so this leans towards "had an effect".
 */
function burst(after: number, before: number): boolean {
  return after > 0 && after > (before > 0 ? before * 1.5 + 2 : 0);
}

export function hadEffect(e: Effect): boolean {
  return (
    e.urlChanged ||
    e.unloaded ||
    e.copied ||
    e.focusMoved ||
    e.expandedChanged ||
    e.opened.length > 0 ||
    e.closed.length > 0 ||
    burst(e.mutations, e.baselineMutations) ||
    burst(e.requests, e.baselineRequests)
  );
}

function navigated(step: SemanticStep, recorded: RecordedEvent[]): boolean {
  return step.events.some((i) => recorded[i]?.event.type === "navigate");
}

function submitted(step: SemanticStep, recorded: RecordedEvent[]): boolean {
  return step.events.some((i) => recorded[i]?.event.type === "submit");
}

function annotateNoise(steps: SemanticStep[], recorded: RecordedEvent[]) {
  const flag = (s: SemanticStep | undefined, rule: string, reason: string, confidence: number) => {
    if (s && !s.noise) s.noise = { rule, reason, confidence };
  };

  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    const next = steps[i + 1];

    if (s.kind === "click") {
      const effective =
        navigated(s, recorded) ||
        submitted(s, recorded) ||
        steps.some((o) => o.kind === "openTab" && o.openedBy === s.id) ||
        (s.effect !== undefined && hadEffect(s.effect));
      if (s.effect && !effective) {
        if (s.target.role) flag(s, "no-effect", "click had no visible effect", 0.7);
        else flag(s, "no-effect", "clicked a non-interactive area; nothing happened", 0.85);
      }
      if (prev?.kind === "click" && sameTarget(prev.target, s.target) && s.ts - prev.ts < REPEAT_CLICK_MS) {
        flag(s, "repeat", "repeated click on the same element", 0.6);
      }
    }

    // Opened something, then immediately closed it again.
    if ((s.kind === "click" || s.kind === "press") && s.effect?.opened.length && next) {
      const closesIt =
        next.effect?.closed.some((c) => s.effect!.opened.includes(c)) &&
        ((next.kind === "press" && next.key === "Escape") || (next.kind === "click" && !navigated(next, recorded)));
      if (closesIt) {
        flag(s, "dismissed", `opened ${s.effect.opened[0]} and closed it without using it`, 0.6);
        flag(next, "dismissed", `closed ${s.effect.opened[0]} right after opening it`, 0.6);
      }
    }

    // Went to a page and came straight back.
    if (s.kind === "navigate" && s.back && prev && (prev.kind === "navigate" || navigated(prev, recorded))) {
      const before = prev.kind === "navigate" ? [...steps.slice(0, i - 1)].reverse().find((x) => x.tabId === s.tabId)?.url : prev.url;
      if (before && before === s.url) {
        flag(prev, "detour", "went to a page and came straight back", 0.65);
        flag(s, "detour", "went back without doing anything on the page", 0.65);
      }
    }

    // Looked at another tab and came back without doing anything there.
    if (s.kind === "switchTab" && !s.initial && prev && next?.kind === "switchTab" && next.tabId === prev.tabId) {
      flag(s, "glance", "looked at another tab without doing anything there", 0.5);
      flag(next, "glance", "came back from a tab without doing anything there", 0.5);
    }
  });
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

/** One-line summary of what an action changed, for display. */
export function describeEffect(e: Effect): string {
  const parts: string[] = [];
  if (e.unloaded || e.urlChanged) parts.push("navigated");
  if (e.opened.length) parts.push(`opened ${e.opened.join(", ")}`);
  if (e.closed.length) parts.push(`closed ${e.closed.join(", ")}`);
  if (e.copied) parts.push("copied");
  if (e.expandedChanged) parts.push("expanded/collapsed");
  if (e.focusMoved) parts.push("moved focus");
  if (burst(e.mutations, e.baselineMutations)) parts.push(`${e.mutations} DOM changes`);
  if (burst(e.requests, e.baselineRequests)) parts.push(`${e.requests} request${e.requests === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "no visible effect";
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
