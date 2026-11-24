import type { PageInventory } from "@d2a/shared";
import { INTERACTIVE_SELECTOR, lightFingerprint } from "./fingerprint.js";

const MAX_ITEMS = 300;

/** Visible interactive elements in the current page state, in-viewport ones first. */
export function pageInventory(): PageInventory {
  const visible: { el: Element; inView: boolean }[] = [];
  for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    visible.push({ el, inView });
  }
  visible.sort((a, b) => Number(b.inView) - Number(a.inView));
  return visible
    .slice(0, MAX_ITEMS)
    .map(({ el }) => ({ tag: el.tagName.toLowerCase(), fingerprint: lightFingerprint(el) }));
}
