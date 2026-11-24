import { expect, test } from "@playwright/test";
import type { Workflow } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { recordFixtureDemo } from "./demo.js";
import { API, launch, runWorkflow } from "./harness.js";

type CompileResponse = { workflow: Workflow; rounds: number; corrections: string[][]; error?: string };

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as CompileResponse;
  expect(res.ok, json.error).toBe(true);
  return json;
};

// Live: calls Claude twice (needs ANTHROPIC_API_KEY). LIVE=1 pnpm test:e2e
test("a follow-up request updates the compiled automation: closing ad tabs", async () => {
  test.setTimeout(400_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const recordingId = await recordFixtureDemo(env, fixture.origin, { withAds: true });
    const first = await post(`/recordings/${recordingId}/compile`, { instruction: "Repeat this for every video in the playlist" });
    console.log("first notes:", JSON.stringify(first.workflow.notes, null, 2));

    const updated = await post(`/workflows/${first.workflow.id}/refine`, {
      answers: (first.workflow.notes?.questions ?? []).map((question) => ({ question, answer: "Do whatever the demonstration did." })),
      request: "The downloader opens ad tabs; close them automatically.",
    });
    console.log("updated notes:", JSON.stringify(updated.workflow.notes, null, 2));
    expect(updated.workflow.id).toBe(first.workflow.id);
    expect(updated.workflow.closePopups).toBe(true);
    expect(updated.workflow.notes?.problems).toEqual([]);

    fixture.log.length = 0;
    const run = await runWorkflow(updated.workflow, { delayMs: 0 }, undefined, 150_000);
    console.log(run.log.map((l) => `${l.level}: ${l.message}`).join("\n"));
    expect(run.status).toBe("done");
    expect(fixture.log).toEqual([1, 2, 3, 4].map((i) => `${fixture.origin}/share/vid${i}`));
    expect(env.context.pages().some((p) => p.url().includes("/ad.html"))).toBe(false);
  } finally {
    await env.close();
    await fixture.close();
  }
});
