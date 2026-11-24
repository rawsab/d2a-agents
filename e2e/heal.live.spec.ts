import { expect, test } from "@playwright/test";
import { type Workflow, findStep } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { fixtureWorkflow } from "../fixtures/workflow.js";
import { API, launch, runWorkflow } from "./harness.js";

// Live: asks Claude to heal (needs ANTHROPIC_API_KEY). LIVE=1 pnpm test:e2e
test("a button relabelled mid-run is healed, the fix is saved, and Undo puts the original back", async () => {
  test.setTimeout(180_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const wf = fixtureWorkflow(fixture.origin, "", "?relabel=Get%20it");
    const run = await runWorkflow(wf, { delayMs: 0, retries: 0 }, undefined, 150_000);
    if (run.status !== "done") console.log(run.log.map((l) => `${l.level}: ${l.message}`).join("\n"));
    expect(run.items.map((i) => i.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(fixture.log).toEqual([1, 2, 3, 4].map((i) => `${fixture.origin}/share/vid${i}`));

    // Healed once, on item 2; later items used the saved element without asking again.
    expect(run.heals).toHaveLength(1);
    expect(run.heals[0]).toMatchObject({ stepId: "s3.7", item: 1, to: { fingerprint: { role: "button", name: "Get it" } } });
    const stored = async () => (await (await fetch(`${API}/workflows/${wf.id}`)).json()) as Workflow;
    expect(findStep((await stored()).steps, "s3.7")).toMatchObject({ target: { fingerprint: { name: "Get it" } } });

    const res = await fetch(`${API}/runs/${run.id}/heals/0/revert`, { method: "POST" });
    expect(res.ok).toBe(true);
    expect(findStep((await stored()).steps, "s3.7")).toMatchObject({ target: { fingerprint: { name: "Download" } } });
    expect((await (await fetch(`${API}/runs/${run.id}`)).json()).heals[0].reverted).toBe(true);
  } finally {
    await env.close();
    await fixture.close();
  }
});
