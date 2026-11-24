/**
 * Remembers the last value copied in this tab, whether by page JS (forwarded by mainworld.js)
 * or a copy event. Replay reads it instead of the system clipboard, which needs focus and permission.
 */
export function trackClipboard(signal: AbortSignal) {
  let last: { value: string; ts: number } | null = null;
  const set = (value: unknown) => {
    if (typeof value === "string" && value) last = { value, ts: Date.now() };
  };
  addEventListener("__d2a_clipboard", (e) => set((e as CustomEvent).detail), { signal });
  addEventListener(
    "copy",
    (e) => set(e.clipboardData?.getData("text/plain") || window.getSelection()?.toString()),
    { passive: true, signal },
  );
  return () => last;
}
