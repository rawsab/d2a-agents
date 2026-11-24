import type { PageInventory } from "@d2a/shared";
import { type ContentEvent, installRecorder } from "./recorder.js";

const KEY = "recording";
let recording = false;

chrome.storage.session.get(KEY).then((r) => (recording = Boolean(r[KEY]))).catch(() => {});
const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
  if (area === "session" && KEY in changes) recording = Boolean(changes[KEY].newValue);
};
chrome.storage.onChanged.addListener(onStorage);

function send(event: ContentEvent, inventory?: PageInventory) {
  try {
    chrome.runtime.sendMessage({ type: "contentEvent", event, inventory }).catch(() => {});
  } catch {
    // Extension was reloaded; this orphaned script can no longer reach it.
    recording = false;
  }
}

// The background re-injects this script into open tabs, and a copy from before an extension
// reload may still be attached. The newest install replaces any previous one.
const g = globalThis as { __d2aDisposeRecorder?: () => void };
g.__d2aDisposeRecorder?.();
const uninstall = installRecorder(() => recording, send);
g.__d2aDisposeRecorder = () => {
  uninstall();
  try {
    chrome.storage.onChanged.removeListener(onStorage);
  } catch {
    // Orphaned context: the chrome API is gone already.
  }
};
