import { expect, test } from "@playwright/test";
import { type Recording, type Workflow, findStep, mergeEvents } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { fixtureWorkflow } from "../fixtures/workflow.js";
import { recordFixtureDemo } from "./demo.js";
import { API, launch, runWorkflow } from "./harness.js";

test("the editor edits a workflow: element picker, insert, problems, reorder, save, and it still runs", async () => {
  test.setTimeout(60_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const recordingId = await recordFixtureDemo(env, fixture.origin);
    const recording = (await (await fetch(`${API}/recordings/${recordingId}`)).json()) as Recording;
    const recorded = mergeEvents(recording.events);
    const shareClick = recorded.find((s) => s.kind === "click" && s.target.name === "Share")!;
    const downloadClick = recorded.find((s) => s.kind === "click" && s.target.name === "Download")!;
    const copyStep = recorded.find((s) => s.kind === "copy")!;
    expect(recording.events.some((e) => e.viewport)).toBe(true);

    // The hand-written fixture workflow, linked to the recording like a compiled one would be.
    const wf: Workflow = { ...fixtureWorkflow(fixture.origin), id: "editor-test", recordingId };
    const loop = wf.steps[2];
    if (loop.kind !== "forEach") throw new Error("expected forEach");
    const download = loop.body.find((s) => s.id === "s3.7");
    if (download?.kind !== "click") throw new Error("expected click");
    download.basedOn = [downloadClick.id];
    download.target.source = { step: downloadClick.id };
    const share = loop.body.find((s) => s.id === "s3.2");
    if (share?.kind !== "click") throw new Error("expected click");
    share.target.source = { step: shareClick.id };
    await fetch(`${API}/workflows`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wf) });
    const stored = async () => (await (await fetch(`${API}/workflows/${wf.id}`)).json()) as Workflow;

    const page = await env.context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`chrome-extension://${env.extensionId}/src/editor/index.html?id=${wf.id}`);
    await expect(page.locator(".card")).toHaveCount(11);
    await expect(page.locator(".rec li")).toHaveCount(recorded.length);
    // The Share step shows its recorded screenshot, with the element it clicks boxed.
    const shareCard = page.locator(".card", { hasText: "click this video's Share button" });
    await expect(shareCard.locator(".thumb .box")).toBeVisible();
    await shareCard.click();
    await expect(page.locator(".panel .zoom .box")).toHaveCount(1);

    // Pick a different element on another recorded page state, then put the Download button back.
    const downloadCard = page.locator(".card", { hasText: "click Download button" });
    await downloadCard.click();
    await page.getByRole("button", { name: "Choose another" }).click();
    const picker = page.getByRole("dialog", { name: "Choose an element" });
    await picker.getByLabel("Page state").selectOption(copyStep.id);
    await picker.locator("li", { hasText: "Copy" }).first().click();
    await expect(picker).toBeHidden();
    await expect(page.locator(".node.selected > .card")).toContainText("Click Download button"); // the description is kept
    await expect(page.locator("#f-Name")).toHaveValue("Copy");
    await page.getByRole("button", { name: "Choose another" }).click();
    await picker.getByLabel("Page state").selectOption(downloadClick.id);
    await picker.locator("li", { hasText: "Download" }).click();
    await expect(page.locator("#f-Name")).toHaveValue("Download");

    // Insert a step after it, and see a problem flagged until it's fixed.
    await page.getByRole("button", { name: "Insert after" }).click();
    await page.getByRole("option", { name: "Wait for" }).click();
    await expect(page.locator(".card")).toHaveCount(12);
    await page.locator("#f-Text").fill("Queued {{lnk}}");
    await expect(page.locator(".node.selected .problem")).toContainText("{{lnk}} refers to a variable that isn't set");
    await expect(page.locator("#problems-pill")).toHaveText("1 problem");
    await page.locator("#f-Text").fill("Queued {{link}}");
    await expect(page.locator(".problem")).toHaveCount(0);
    await expect(page.locator("#problems-pill")).toBeHidden();

    // Reorder: move the new step up past Download and back.
    await page.locator(".node.selected > .card").getByRole("button", { name: "Move up" }).click();
    await expect(page.locator(".loop .card").nth(7)).toContainText("Wait for");
    await page.keyboard.press("Alt+ArrowDown"); // the same with the keyboard
    await expect(page.locator(".loop .card").nth(8)).toContainText("Wait for");

    // Delete it, undo the delete.
    await page.keyboard.press("Backspace");
    await expect(page.locator(".card")).toHaveCount(11);
    await page.getByRole("button", { name: "Undo" }).last().click(); // the toast's
    await expect(page.locator(".card")).toHaveCount(12);

    await expect(page.locator("#state")).toHaveText("Unsaved changes");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#state")).toHaveText("Saved");

    const after = await stored();
    const body = after.steps[2].kind === "forEach" ? after.steps[2].body : [];
    expect(body.map((s) => s.id)).toEqual(["s3.1", "s3.2", "s3.3", "s3.4", "s3.5", "s3.6", "s3.7", "e1", "s3.8"]);
    expect(findStep(after.steps, "e1")).toEqual({ id: "e1", kind: "waitFor", textIncludes: "Queued {{link}}" });
    expect(findStep(after.steps, "s3.7")).toMatchObject({
      target: { description: "Download button", fingerprint: { role: "button", name: "Download" }, source: { step: downloadClick.id } },
    });

    fixture.log.length = 0;
    const run = await runWorkflow(after, { delayMs: 0, limit: 2 });
    expect(run.status).toBe("done");
    expect(fixture.log).toEqual([1, 2].map((i) => `${fixture.origin}/share/vid${i}`));
  } finally {
    await env.close();
    await fixture.close();
  }
});
