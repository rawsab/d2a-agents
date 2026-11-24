import { PROTOCOL_VERSION, SERVER_PORT } from "@d2a/shared";
import { ServerConnection } from "./connection.js";

const conn = new ServerConnection(`ws://127.0.0.1:${SERVER_PORT}/ws`);

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

// The side panel asks for connection status.
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req?.type === "getStatus") sendResponse({ connected: conn.ready });
});
