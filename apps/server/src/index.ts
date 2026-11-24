import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { Command, SERVER_PORT } from "@d2a/shared";
import { ExtensionBridge } from "./bridge.js";
import { Store } from "./store.js";

const store = new Store();
const bridge = new ExtensionBridge(store);
const app = Fastify({ logger: { level: "info" } });

app.get("/health", async () => ({ ok: true, extensionConnected: bridge.connected }));
app.get("/recordings", async () => store.listRecordings());
app.get<{ Params: { id: string } }>("/recordings/:id", async (req, reply) => {
  const rec = store.getRecording(req.params.id);
  return rec ?? reply.code(404).send({ error: "not found" });
});
// Debug hook: run one low-level command against the browser.
app.post("/debug/command", async (req) => bridge.execute(Command.parse(req.body)));

const wss = new WebSocketServer({ noServer: true });
app.server.on("upgrade", (req, socket, head) => {
  // Only the extension may connect; reject web pages that try to reach the local socket.
  if (req.url !== "/ws" || !req.headers.origin?.startsWith("chrome-extension://")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => bridge.attach(ws));
});

await app.listen({ host: "127.0.0.1", port: SERVER_PORT });
