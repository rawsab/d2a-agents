import { expect, test } from "@playwright/test";
import { type Recording, mergeEvents } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { API, launch } from "./harness.js";

test("flags accidental clicks and dismissed dialogs in a real recording, and honors overrides", async () => {
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const { context, panel } = env;
    const list = await context.newPage();
    await list.goto(`${fixture.origin}/list.html`);
    const form = await context.newPage();
    await form.goto(`${fixture.origin}/form.html`);

    await list.bringToFront();
    const rec = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "startRecording", name: "noisy" }));
    await list.waitForTimeout(300);

    await list.getByRole("heading").click(); // accidental click on a non-interactive area
    await list.waitForTimeout(900);
    await list.getByRole("button", { name: "Share" }).first().click(); // opened by mistake…
    await list.waitForTimeout(900);
    await list.keyboard.press("Escape"); // …and dismissed
    await list.waitForTimeout(900);
    await list.getByRole("button", { name: "Share" }).nth(1).click(); // the real flow
    await list.getByRole("button", { name: "Copy" }).click();
    await list.waitForTimeout(900);
    await form.bringToFront();
    await form.getByLabel("Paste link").click();
    await form.keyboard.press("ControlOrMeta+V");
    await form.getByRole("button", { name: "Download" }).click();
    await expect(form.getByRole("status")).toContainText("Queued");
    await form.waitForTimeout(1000); // let the last effect window close

    await panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopRecording" }));
    await list.waitForTimeout(300);

    const get = async () => (await (await fetch(`${API}/recordings/${rec.id}`)).json()) as Recording;
    let recording = await get();
    let steps = mergeEvents(recording.events, recording.overrides);
    const summary = steps.map((s) => [s.kind, s.noise?.rule ?? null]);
    console.log(summary.map((s) => s.join(": ")).join("\n"));
    expect(summary).toEqual([
      ["switchTab", null],
      ["click", "no-effect"],
      ["click", "dismissed"],
      ["press", "dismissed"],
      ["click", null],
      ["copy", null],
      ["switchTab", null],
      ["fill", null],
      ["click", null],
    ]);
    expect(steps[4].effect?.opened).toEqual(['dialog "Share this video"']);
    expect(steps[8].effect?.requests).toBeGreaterThan(0); // the Download fetch was observed
    expect(steps[8].effect?.appeared).toContain(`Queued ${fixture.origin}/share/vid2`);

    // The user disagrees about the heading click; the decision is stored and applied.
    const put = await fetch(`${API}/recordings/${rec.id}/overrides/${steps[1].events[0]}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noise: false }),
    });
    expect(put.ok).toBe(true);
    recording = await get();
    steps = mergeEvents(recording.events, recording.overrides);
    expect(steps[1]).toMatchObject({ noise: undefined, keptByUser: true });
  } finally {
    await env.close();
    await fixture.close();
  }
});
