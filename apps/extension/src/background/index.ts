import { PROTOCOL_VERSION } from "@d2a/shared";
import { WS_URL } from "../config.js";
import { ServerConnection } from "./connection.js";
import { Recorder } from "./recorder.js";

const MAIN_WORLD_SCRIPT_ID = "d2a-mainworld";

const conn = new ServerConnection(WS_URL);
const recorder = new Recorder(conn);

conn.onMessage((msg) => {
  if (msg.type === "command") {
    // Executor arrives in milestone 3.
    conn.send({ type: "commandResult", requestId: msg.requestId, ok: false, error: "not implemented" });
  }
});
conn.onOpen(() =>
  conn.send({ type: "hello", version: PROTOCOL_VERSION, extensionId: chrome.runtime.id }),
);
conn.connect();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

/**
 * Declared content scripts only load into pages opened after the extension (re)loads, so
 * tabs that were already open get the recorder injected explicitly. Both scripts are idempotent.
 */
async function injectIntoOpenTabs() {
  const files = chrome.runtime.getManifest().content_scripts?.flatMap((cs) => cs.js ?? []) ?? [];
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const target = { tabId: tab.id };
      try {
        await chrome.scripting.executeScript({ target, files: ["mainworld.js"], world: "MAIN" });
        await chrome.scripting.executeScript({ target, files });
      } catch {
        // Pages extensions can't script (Chrome Web Store, PDF viewer, discarded tabs).
      }
    }),
  );
}

// Page-world clipboard hook (public/mainworld.js); registered dynamically because it must run in world MAIN.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.scripting.unregisterContentScripts({ ids: [MAIN_WORLD_SCRIPT_ID] }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    { id: MAIN_WORLD_SCRIPT_ID, js: ["mainworld.js"], matches: ["<all_urls>"], runAt: "document_start", world: "MAIN" },
  ]);
  await injectIntoOpenTabs();
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  const reply = (p: Promise<unknown>) => {
    p.then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true; // keep the channel open for the async response
  };
  switch (req?.type) {
    case "getStatus":
      return reply(recorder.state().then((recording) => ({ connected: conn.ready, recording })));
    case "startRecording":
      return reply(injectIntoOpenTabs().then(() => recorder.start(req.name ?? "")));
    case "stopRecording":
      return reply(recorder.stop());
    case "contentEvent":
      recorder.fromContent(req.event, req.inventory, sender);
      return false;
  }
  return false;
});
