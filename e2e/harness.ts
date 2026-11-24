import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Worker } from "@playwright/test";
import type { RunOptions, RunSnapshot, Workflow } from "@d2a/shared";

const ROOT = join(import.meta.dirname, "..");
/** Separate port and build so tests never touch a running dev server's data. */
export const E2E_PORT = 7831;
const EXTENSION = join(ROOT, "apps/extension/dist-e2e");
export const API = `http://127.0.0.1:${E2E_PORT}`;

export async function health(): Promise<{ ok: boolean; extensionConnected: boolean } | undefined> {
  try {
    return await (await fetch(`${API}/health`)).json();
  } catch {
    return undefined;
  }
}

export async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts an isolated server (temp DB) and Chromium with the unpacked extension loaded. */
export async function launch() {
  if (await health()) {
    throw new Error(`e2e port ${E2E_PORT} is in use; is another test run still going?`);
  }
  const tmp = await mkdtemp(join(tmpdir(), "d2a-e2e-"));
  const server: ChildProcess = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, D2A_DB: join(tmp, "test.db"), D2A_PORT: String(E2E_PORT) },
    stdio: "ignore",
    detached: true, // own process group, so close() also stops the server npx spawned
  });
  await until(health, "server");

  const context: BrowserContext = await chromium.launchPersistentContext(join(tmp, "profile"), {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const sw: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(sw.url()).host;
  await until(async () => (await health())?.extensionConnected, "extension to connect");
  await until(
    async () => (await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length > 0,
    "main-world script registration",
  );

  // The side panel page, opened as a tab, is used to send commands to the background.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

  return {
    context,
    panel,
    extensionId,
    async close() {
      await context.close();
      const exited = new Promise((r) => server.once("exit", r));
      process.kill(-server.pid!, "SIGTERM");
      await exited;
      await until(async () => !(await health()), "server to stop");
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Saves a workflow, starts a run, and waits for it to finish. */
export async function runWorkflow(
  workflow: Workflow,
  options: Partial<RunOptions> = {},
  onStart?: (run: RunSnapshot) => Promise<void>,
  timeoutMs = 50_000,
) {
  const post = (path: string, body: unknown) =>
    fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const saved = await post("/workflows", workflow);
  if (!saved.ok) throw new Error(`saving workflow failed: ${await saved.text()}`);
  const started = await post(`/workflows/${workflow.id}/runs`, options);
  if (!started.ok) throw new Error(`starting run failed: ${await started.text()}`);
  const run = (await started.json()) as RunSnapshot;
  await onStart?.(run);
  const snapshot = async () => (await (await fetch(`${API}/runs/${run.id}`)).json()) as RunSnapshot;
  try {
    return await until(async () => {
      const snap = await snapshot();
      return snap.finishedAt ? snap : undefined;
    }, "run to finish", timeoutMs);
  } catch (err) {
    const log = (await snapshot()).log.slice(-15).map((l) => `  ${l.level}: ${l.message}`).join("\n");
    throw new Error(`${(err as Error).message}; last log:\n${log}`);
  }
}
