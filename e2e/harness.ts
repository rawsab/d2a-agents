import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Worker } from "@playwright/test";
import { SERVER_PORT } from "@d2a/shared";

const ROOT = join(import.meta.dirname, "..");
const EXTENSION = join(ROOT, "apps/extension/dist");
export const API = `http://127.0.0.1:${SERVER_PORT}`;

export async function health(): Promise<{ ok: boolean; extensionConnected: boolean } | undefined> {
  try {
    return await (await fetch(`${API}/health`)).json();
  } catch {
    return undefined;
  }
}

async function until<T>(fn: () => Promise<T | undefined | false>, what: string, ms = 15_000): Promise<T> {
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
    throw new Error(`port ${SERVER_PORT} is in use (is \`pnpm dev:server\` running?). Stop it before running e2e tests.`);
  }
  const tmp = await mkdtemp(join(tmpdir(), "d2a-e2e-"));
  const server: ChildProcess = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, D2A_DB: join(tmp, "test.db") },
    stdio: "ignore",
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
      server.kill();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}
