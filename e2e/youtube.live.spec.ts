import { expect, test } from "@playwright/test";
import { startFixtureServer } from "../fixtures/server.js";
import { youtubeWorkflow } from "../fixtures/workflow.js";
import { launch, runWorkflow } from "./harness.js";

const PLAYLIST = "https://www.youtube.com/watch?v=6TBIk2CTnjE&list=PLWm-zsvwLDDF16u3QX035IgdXkeIpATOU";

// Live check against real YouTube (network required): LIVE=1 pnpm test:e2e
test("YouTube playlist → fixture downloader", async () => {
  test.setTimeout(150_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const wf = youtubeWorkflow(PLAYLIST, `${fixture.origin}/form.html`);
    const run = await runWorkflow(wf, { limit: 3, delayMs: 0 }, undefined, 100_000);
    console.log(run.log.map((l) => `${l.level}: ${l.message}`).join("\n"));
    console.log("downloader received:", fixture.log);
    expect(run.items.map((i) => i.status)).toEqual(["ok", "ok", "ok"]);
  } finally {
    await env.close();
    await fixture.close();
  }
});
