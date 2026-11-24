import type { Fingerprint, PageInventory, RawEvent } from "@d2a/shared";
import { fingerprint, interactiveAncestor } from "./fingerprint.js";
import { pageInventory } from "./inventory.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Raw event as seen by a content script; the background fills in tabId. */
export type ContentEvent = DistributiveOmit<RawEvent, "tabId">;
export type Emit = (event: ContentEvent, inventory?: PageInventory) => void;

const RECORDED_KEYS = new Set(["Enter", "Escape"]);
const COPY_DEDUPE_MS = 500;

function isMasked(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "password") return true;
  const ac = el.getAttribute("autocomplete") ?? "";
  return /cc-|one-time-code|current-password|new-password/.test(ac);
}

function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).innerText;
  return undefined;
}

function selectedText(): string {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const { selectionStart: s, selectionEnd: e, value } = active;
    if (s !== null && e !== null && e > s) return value.slice(s, e);
  }
  return window.getSelection()?.toString() ?? "";
}

/** Installs capture listeners; events are emitted only while isRecording() is true. */
export function installRecorder(isRecording: () => boolean, emit: Emit) {
  let pending: { el: Element; target: Fingerprint; value: string; masked: boolean } | undefined;
  let lastCopy: { value: string; ts: number } | undefined;
  const page = () => ({ url: location.href, title: document.title, ts: Date.now() });

  /** Typing is coalesced; the final value is emitted when the user moves on. */
  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = undefined;
    emit({ ...page(), type: "input", target: p.target, value: p.masked ? "" : p.value, masked: p.masked });
  };

  const emitCopy = (value: string, target?: Fingerprint) => {
    const now = Date.now();
    if (!value || (lastCopy && lastCopy.value === value && now - lastCopy.ts < COPY_DEDUPE_MS)) return;
    lastCopy = { value, ts: now };
    emit({ ...page(), type: "copy", value, target });
  };

  const opts = { capture: true, passive: true };

  addEventListener("click", (e) => {
    if (!isRecording() || !e.isTrusted || !(e.target instanceof Element)) return;
    const el = interactiveAncestor(e.target);
    if (pending && pending.el !== el) flush();
    // Inventory is taken before the click changes the page: what the user could choose from.
    const inventory = pageInventory();
    emit({ ...page(), type: "click", target: fingerprint(el) }, inventory);
  }, opts);

  addEventListener("input", (e) => {
    if (!isRecording() || !e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target;
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return; // clicks cover these
    const value = valueOf(el);
    if (value === undefined) return;
    if (pending && pending.el !== el) flush();
    if (pending) pending.value = value;
    else pending = { el, target: fingerprint(el), value, masked: isMasked(el) };
  }, opts);

  addEventListener("change", (e) => {
    if (!isRecording() || !e.isTrusted || !(e.target instanceof HTMLSelectElement)) return;
    const el = e.target;
    pending = { el, target: fingerprint(el), value: el.value, masked: false };
    flush();
  }, opts);

  addEventListener("focusout", (e) => {
    if (pending && e.target === pending.el) flush();
  }, opts);

  addEventListener("keydown", (e) => {
    if (!isRecording() || !e.isTrusted || !RECORDED_KEYS.has(e.key) || !(e.target instanceof Element)) return;
    flush();
    emit({ ...page(), type: "keydown", target: fingerprint(e.target), key: e.key }, pageInventory());
  }, opts);

  addEventListener("submit", (e) => {
    if (!isRecording() || !(e.target instanceof Element)) return;
    flush();
    emit({ ...page(), type: "submit", target: fingerprint(e.target) });
  }, opts);

  addEventListener("paste", (e) => {
    if (!isRecording() || !e.isTrusted || !(e.target instanceof Element)) return;
    const value = e.clipboardData?.getData("text/plain") ?? "";
    const el = e.target.closest("input, textarea, [contenteditable]") ?? e.target;
    if (pending && pending.el !== el) flush();
    emit({ ...page(), type: "paste", target: fingerprint(el), value: isMasked(el) ? "" : value }, pageInventory());
  }, opts);

  // Bubble phase on window runs after page handlers, so data they set via setData() is visible.
  addEventListener("copy", (e) => {
    if (!isRecording()) return;
    const value = e.clipboardData?.getData("text/plain") || selectedText();
    const target = e.target instanceof Element ? fingerprint(interactiveAncestor(e.target)) : undefined;
    emitCopy(value, target);
  }, { passive: true });

  // Clipboard writes from page JS, forwarded by mainworld.js.
  addEventListener("__d2a_clipboard", (e) => {
    if (!isRecording()) return;
    const value = (e as CustomEvent).detail;
    if (typeof value === "string") emitCopy(value);
  });

  addEventListener("pagehide", flush, opts);
}
