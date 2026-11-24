import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { Command, SERVER_PORT, Workflow } from "@d2a/shared";
import { ExtensionBridge } from "./bridge.js";
import { ClaudeCompilerModel, CompileError, SAMPLE_ITEMS, compile } from "./compiler/index.js";
import { RunManager } from "./runs.js";
import { Store } from "./store.js";

// ANTHROPIC_API_KEY and other settings can live in the repo's .env (gitignored).
const envFile = join(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

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
app.post<{ Params: { id: string }; Body: { instruction?: string } }>("/recordings/:id/compile", async (req, reply) => {
  const recording = store.getRecording(req.params.id);
  if (!recording) return reply.code(404).send({ error: "not found" });
  const instruction = req.body?.instruction?.trim();
  if (!instruction) return reply.code(400).send({ error: "instruction is required" });
  // Check setup steps against the live page when the browser is free.
  const canPreview = bridge.connected && !runs.current;
  try {
    const result = await compile(recording, instruction, {
      model: new ClaudeCompilerModel(),
      loadScreenshot: (id) => store.getScreenshot(id),
      preview: canPreview ? (wf) => runs.preview(wf, SAMPLE_ITEMS) : undefined,
    });
    const { summary, excludedSteps, assumptions, questions } = result.compiled;
    const workflow = { ...result.workflow, notes: { summary, excludedSteps, assumptions, questions, problems: result.problems } };
    store.saveWorkflow(workflow);
    return { workflow, preview: result.preview ?? null, rounds: result.rounds, checkedOnLivePage: canPreview };
  } catch (err) {
    if (err instanceof CompileError) return reply.code(422).send({ error: err.message });
    // With no credentials at all the SDK throws a plain Error (no typed class) when the request is made.
    const noCredentials = err instanceof Error && err.message.startsWith("Could not resolve authentication method");
    if (err instanceof Anthropic.AuthenticationError || noCredentials) {
      return reply.code(401).send({ error: "Claude API key missing or invalid: set ANTHROPIC_API_KEY (e.g. in the repo's .env)" });
    }
    if (err instanceof Anthropic.RateLimitError) return reply.code(429).send({ error: "Claude API rate limit; try again shortly" });
    if (err instanceof Anthropic.APIError) return reply.code(502).send({ error: `Claude API error ${err.status}: ${err.message}` });
    if (err instanceof Anthropic.AnthropicError) return reply.code(503).send({ error: err.message });
    throw err;
  }
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
