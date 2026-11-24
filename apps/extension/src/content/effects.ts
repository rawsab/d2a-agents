import type { Effect } from "@d2a/shared";
import { clean, roleOf } from "./fingerprint.js";

export const EFFECT_WINDOW_MS = 750;
const HISTORY_MS = 5_000;
const OVERLAY_SELECTORS = [
  "dialog[open]",
  "[role=dialog]",
  "[role=alertdialog]",
  "[aria-modal=true]",
  "[role=menu]",
  "[role=listbox]",
  ":popover-open",
];

/** Rolling record of DOM mutations and network requests. Only observes while recording. */
export class PageActivity {
  private mutations: [number, number][] = [];
  private requests: number[] = [];
  private mo = new MutationObserver((records) => this.mutations.push([performance.now(), records.length]));
  private po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) this.requests.push(entry.startTime);
  });
  private active = false;

  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      try {
        this.po.observe({ type: "resource" });
      } catch {
        // resource timing unavailable; mutation counts still work
      }
    } else {
      this.mo.disconnect();
      this.po.disconnect();
      this.mutations = [];
      this.requests = [];
    }
  }

  /** Mutation records and requests started in [from, to) (performance.now() time). */
  count(from: number, to: number) {
    const cutoff = performance.now() - HISTORY_MS;
    this.mutations = this.mutations.filter(([t]) => t >= cutoff);
    this.requests = this.requests.filter((t) => t >= cutoff);
    return {
      mutations: this.mutations.reduce((n, [t, c]) => (t >= from && t < to ? n + c : n), 0),
      requests: this.requests.filter((t) => t >= from && t < to).length,
    };
  }
}

/** A dialog's label: aria-label/labelledby, else its heading, else its first line of text. */
function overlayName(el: Element): string | undefined {
  const labelledBy = el.getAttribute("aria-labelledby");
  return (
    clean(el.getAttribute("aria-label"), 40) ??
    (labelledBy ? clean(document.getElementById(labelledBy.split(/\s+/)[0])?.textContent, 40) : undefined) ??
    clean(el.querySelector("h1, h2, h3, h4, h5, h6, [role=heading]")?.textContent, 40) ??
    clean((el as HTMLElement).innerText?.split("\n").find((line) => line.trim()), 40)
  );
}

function visibleOverlays(): Map<Element, string> {
  const out = new Map<Element, string>();
  for (const sel of OVERLAY_SELECTORS) {
    let els: Element[] = [];
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch {
      continue; // selector unsupported in this browser
    }
    for (const el of els) {
      if (out.has(el) || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const name = overlayName(el);
      out.set(el, `${roleOf(el) ?? el.tagName.toLowerCase()}${name ? ` "${name}"` : ""}`);
    }
  }
  return out;
}

/**
 * Measures what an action did: watches for EFFECT_WINDOW_MS, then reports. The window ends early
 * when the next action starts (later changes belong to that action) or the page unloads.
 */
export class EffectProbes {
  private pending = new Set<(unloaded: boolean) => void>();

  constructor(private activity: PageActivity, private lastCopyAt: () => number) {}

  start(target: Element, report: (effect: Effect) => void) {
    this.finishAll(false);
    const t0 = performance.now();
    const started = Date.now();
    const url0 = location.href;
    const focus0 = document.activeElement;
    const expanded0 = target.getAttribute("aria-expanded");
    const overlays0 = visibleOverlays();

    const finish = (unloaded: boolean) => {
      clearTimeout(timer);
      this.pending.delete(finish);
      const now = performance.now();
      const window = Math.min(now - t0, EFFECT_WINDOW_MS);
      const after = this.activity.count(t0, t0 + window);
      const before = this.activity.count(t0 - window, t0);
      const focus = document.activeElement;
      const overlays = visibleOverlays();
      report({
        windowMs: Math.round(window),
        mutations: after.mutations,
        baselineMutations: before.mutations,
        requests: after.requests,
        baselineRequests: before.requests,
        urlChanged: location.href !== url0,
        focusMoved:
          focus !== focus0 && focus !== null && focus !== document.body && focus !== target && !target.contains(focus),
        expandedChanged: target.getAttribute("aria-expanded") !== expanded0,
        opened: [...overlays].filter(([el]) => !overlays0.has(el)).map(([, d]) => d),
        closed: [...overlays0].filter(([el]) => !overlays.has(el)).map(([, d]) => d),
        copied: this.lastCopyAt() >= started,
        unloaded,
      });
    };
    const timer = setTimeout(() => finish(false), EFFECT_WINDOW_MS);
    this.pending.add(finish);
  }

  finishAll(unloaded: boolean) {
    for (const finish of [...this.pending]) finish(unloaded);
  }
}
