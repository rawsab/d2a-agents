import { expect, test } from "@playwright/test";
import { type Workflow, findStep } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { recordFixtureDemo } from "./demo.js";
import { API, launch, runWorkflow } from "./harness.js";

// Live: calls Claude three times (needs ANTHROPIC_API_KEY). LIVE=1 pnpm test:e2e
test("asking Claude for a change in the editor shows a diff; discard keeps the workflow, accept saves it with hand edits kept", async () => {
  test.setTimeout(600_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const recordingId = await recordFixtureDemo(env, fixture.origin);
    const res = await fetch(`${API}/recordings/${recordingId}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "Repeat this for every video in the playlist" }),
    });
    const { workflow, error } = (await res.json()) as { workflow: Workflow; error?: string };
    expect(res.ok, error).toBe(true);
    const stored = async () => (await (await fetch(`${API}/workflows/${workflow.id}`)).json()) as Workflow;

    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/src/editor/index.html?id=${workflow.id}`);
    await page.locator(".card").first().waitFor();

    // A hand edit: describe the Download click differently. Asking Claude saves it first.
    await page.locator(".card", { hasText: /Click .*Download/i }).click();
    await page.locator("#f-Description").fill("the big Download button");
    const ask = async () => {
      await page.locator("#request").fill("At the start of each video, wait until the page shows the text 'Fixture Mix'.");
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await expect(page.locator("#proposal")).toBeVisible({ timeout: 240_000 });
      await expect(page.locator(".node.added", { hasText: "Wait for" })).toHaveCount(1);
    };

    await ask();
    const beforeDiscard = await stored();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.locator("#proposal")).toBeHidden();
    await expect(page.locator(".node.added")).toHaveCount(0);
    expect(await stored()).toEqual(beforeDiscard);

    await ask();
    await page.getByRole("button", { name: "Accept" }).click();
    await expect(page.locator("#proposal")).toBeHidden();
    await expect(page.locator("#state")).toHaveText(/^Saved/);

    const after = await stored();
    const loop = after.steps.find((s) => s.kind === "forEach");
    if (loop?.kind !== "forEach") throw new Error("expected a loop");
    console.log(JSON.stringify(loop.body.map((s) => [s.id, s.kind, "target" in s ? s.target?.description : undefined, "textIncludes" in s ? s.textIncludes : undefined])));
    expect(loop.body.some((s) => s.kind === "waitFor" && s.textIncludes?.includes("Fixture Mix"))).toBe(true);
    expect(loop.body.some((s) => s.kind === "click" && s.target.description === "the big Download button")).toBe(true);

    fixture.log.length = 0;
    const run = await runWorkflow(after, { delayMs: 0, limit: 2 }, undefined, 120_000);
    expect(run.status).toBe("done");
    expect(fixture.log).toEqual([1, 2].map((i) => `${fixture.origin}/share/vid${i}`));
    expect(findStep(after.steps, loop.id)).toBeDefined();
  } finally {
    await env.close();
    await fixture.close();
  }
});
