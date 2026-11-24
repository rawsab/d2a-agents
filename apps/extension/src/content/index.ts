import type { PageInventory } from "@d2a/shared";
import { type ContentEvent, installRecorder } from "./recorder.js";

const KEY = "recording";
let recording = false;

chrome.storage.session.get(KEY).then((r) => (recording = Boolean(r[KEY]))).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && KEY in changes) recording = Boolean(changes[KEY].newValue);
});

function send(event: ContentEvent, inventory?: PageInventory) {
  try {
    chrome.runtime.sendMessage({ type: "contentEvent", event, inventory }).catch(() => {});
  } catch {
    // Extension was reloaded; this orphaned script can no longer reach it.
    recording = false;
  }
}

installRecorder(() => recording, send);
