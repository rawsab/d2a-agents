import type { PageInventory, Viewport } from "@d2a/shared";
import { trackClipboard } from "./clipboard.js";
import { type ExecRequest, handleExec } from "./executor.js";
import { type ContentEvent, type RecorderHandle, installRecorder } from "./recorder.js";

const KEY = "recording";
let recording = false;

const setRecording = (value: boolean) => {
  recording = value;
  recorder?.recordingChanged();
};
chrome.storage.session.get(KEY).then((r) => setRecording(Boolean(r[KEY]))).catch(() => {});
const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
  if (area === "session" && KEY in changes) setRecording(Boolean(changes[KEY].newValue));
};
chrome.storage.onChanged.addListener(onStorage);

function send(event: ContentEvent, inventory?: PageInventory) {
  const viewport: Viewport | undefined = inventory && { w: innerWidth, h: innerHeight };
  try {
    chrome.runtime.sendMessage({ type: "contentEvent", event, inventory, viewport }).catch(() => {});
  } catch {
    // Extension was reloaded; this orphaned script can no longer reach it.
    setRecording(false);
  }
}

// The background re-injects this script into open tabs, and a copy from before an extension
// reload may still be attached. The newest install replaces any previous one.
const g = globalThis as { __d2aDisposeRecorder?: () => void };
g.__d2aDisposeRecorder?.();
const recorder: RecorderHandle | undefined = installRecorder(() => recording, send);
const clipboardAbort = new AbortController();
const lastCopied = trackClipboard(clipboardAbort.signal);

/** Replay commands from the background; errors come back as { error } so the runner can report them. */
const onExec = (req: ExecRequest, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  if (typeof req?.type !== "string" || !req.type.startsWith("exec/")) return false;
  try {
    sendResponse({ result: handleExec(req, lastCopied) ?? null });
  } catch (err) {
    sendResponse({ error: (err as Error).message });
  }
  return false;
};
chrome.runtime.onMessage.addListener(onExec);

g.__d2aDisposeRecorder = () => {
  recorder.dispose();
  clipboardAbort.abort();
  try {
    chrome.storage.onChanged.removeListener(onStorage);
    chrome.runtime.onMessage.removeListener(onExec);
  } catch {
    // Orphaned context: the chrome API is gone already.
  }
};
