import { expect, test } from "@playwright/test";
import type { Workflow } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { recordFixtureDemo } from "./demo.js";
import { API, launch, runWorkflow } from "./harness.js";

// Live: calls Claude (needs ANTHROPIC_API_KEY, in the environment or the repo's .env). LIVE=1 pnpm test:e2e
test("Claude compiles the recorded demonstration into a loop over the playlist, and it runs", async () => {
  test.setTimeout(300_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const recordingId = await recordFixtureDemo(env, fixture.origin, { withNoise: true });
    const res = await fetch(`${API}/recordings/${recordingId}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "Repeat this for every video in the playlist" }),
    });
    const body = (await res.json()) as { workflow: Workflow; rounds: number; corrections: string[][]; error?: string };
    expect(res.ok, body.error).toBe(true);
    console.log(`corrections: ${JSON.stringify(body.corrections)}`);
    console.log(`compiled in ${body.rounds} round(s):\n${JSON.stringify(body.workflow, null, 2)}`);
    expect(body.workflow.notes?.problems).toEqual([]);
    const loop = body.workflow.steps.find((s) => s.kind === "forEach");
    expect(loop).toBeDefined();
    // The Share click opened a dialog in the recording, so it gets a retry condition.
    const share = loop?.kind === "forEach" ? loop.body.find((s) => s.kind === "click" && s.target.fingerprint.name === "Share") : undefined;
    expect(share).toMatchObject({ until: { target: { fingerprint: { name: "Copy" } } } });

    fixture.log.length = 0; // the demonstration itself submitted one link
    const run = await runWorkflow(body.workflow, { delayMs: 0 }, undefined, 120_000);
    console.log(run.log.map((l) => `${l.level}: ${l.message}`).join("\n"));
    expect(run.status).toBe("done");
    expect(fixture.log).toEqual([1, 2, 3, 4].map((i) => `${fixture.origin}/share/vid${i}`));
  } finally {
    await env.close();
    await fixture.close();
  }
});
