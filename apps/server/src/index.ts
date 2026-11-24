import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { Command, SERVER_PORT, Workflow } from "@d2a/shared";
import { ExtensionBridge } from "./bridge.js";
import { RunManager } from "./runs.js";
import { Store } from "./store.js";

const store = new Store();
const bridge = new ExtensionBridge(store);
const runs = new RunManager(store, bridge);
const app = Fastify({ logger: { level: "info" } });

app.get("/health", async () => ({ ok: true, extensionConnected: bridge.connected }));
app.get("/recordings", async () => store.listRecordings());
app.get<{ Params: { id: string } }>("/recordings/:id", async (req, reply) => {
  const rec = store.getRecording(req.params.id);
  return rec ?? reply.code(404).send({ error: "not found" });
});
app.put<{ Params: { id: string; eventIndex: string }; Body: { noise: boolean | null } }>(
  "/recordings/:id/overrides/:eventIndex",
  async (req, reply) => {
    if (!store.getRecording(req.params.id)) return reply.code(404).send({ error: "not found" });
    const noise = req.body?.noise;
    if (noise !== null && typeof noise !== "boolean") return reply.code(400).send({ error: "noise must be true, false or null" });
    store.setOverride(req.params.id, Number(req.params.eventIndex), noise);
    return { ok: true };
  },
);
app.delete<{ Params: { id: string } }>("/recordings/:id", async (req, reply) =>
  store.deleteRecording(req.params.id) ? { ok: true } : reply.code(404).send({ error: "not found" }),
);
app.get<{ Params: { id: string } }>("/screenshots/:id", async (req, reply) => {
  const shot = store.getScreenshot(req.params.id);
  if (!shot) return reply.code(404).send({ error: "not found" });
  return reply.type(shot.mime).header("cache-control", "max-age=31536000, immutable").send(Buffer.from(shot.data));
});
app.get("/workflows", async () => store.listWorkflows());
app.post("/workflows", async (req, reply) => {
  const body = req.body as Record<string, unknown>;
  const parsed = Workflow.safeParse({ ...body, id: body?.id ?? randomUUID() });
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
  store.saveWorkflow(parsed.data);
  return parsed.data;
});
app.get<{ Params: { id: string } }>("/workflows/:id", async (req, reply) => {
  return store.getWorkflow(req.params.id) ?? reply.code(404).send({ error: "not found" });
});
app.delete<{ Params: { id: string } }>("/workflows/:id", async (req, reply) =>
  store.deleteWorkflow(req.params.id) ? { ok: true } : reply.code(404).send({ error: "not found" }),
);

app.post<{ Params: { id: string } }>("/workflows/:id/runs", async (req, reply) => {
  const workflow = store.getWorkflow(req.params.id);
  if (!workflow) return reply.code(404).send({ error: "not found" });
  if (!bridge.connected) return reply.code(409).send({ error: "extension not connected" });
  try {
    return runs.start(workflow, req.body);
  } catch (err) {
    return reply.code(409).send({ error: (err as Error).message });
  }
});
app.get("/runs/current", async () => runs.current ?? null);
app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
  return (runs.current?.id === req.params.id ? runs.current : store.getRun(req.params.id)) ?? reply.code(404).send({ error: "not found" });
});
for (const action of ["pause", "resume", "stop"] as const) {
  app.post<{ Params: { id: string } }>(`/runs/:id/${action}`, async (req, reply) =>
    runs.control(req.params.id, action) ? { ok: true } : reply.code(404).send({ error: "no such active run" }),
  );
}

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

await app.listen({ host: "127.0.0.1", port: Number(process.env.D2A_PORT) || SERVER_PORT });
