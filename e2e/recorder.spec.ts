import { expect, test } from "@playwright/test";
import { type Recording, describeStep, mergeEvents } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { API, launch } from "./harness.js";

test("records the share → copy → paste → download demonstration", async () => {
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const { context, panel } = env;
    const list = await context.newPage();
    await list.goto(`${fixture.origin}/list.html`);
    const form = await context.newPage();
    await form.goto(`${fixture.origin}/form.html`);

    await list.bringToFront();
    const rec = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "startRecording", name: "e2e demo" }));
    await list.waitForTimeout(300); // let content scripts see the recording flag

    await list.getByRole("button", { name: "Share" }).nth(1).click();
    await list.getByRole("button", { name: "Copy" }).click();

    await form.bringToFront();
    await form.getByLabel("Paste link").click();
    await form.keyboard.press("ControlOrMeta+V");
    await form.getByRole("button", { name: "Download" }).click();
    await expect(form.getByRole("status")).toContainText("Queued");

    await panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopRecording" }));
    await list.waitForTimeout(300);

    const shareUrl = `${fixture.origin}/share/vid2`;
    expect(fixture.log).toEqual([shareUrl]);

    const recording = (await (await fetch(`${API}/recordings/${rec.id}`)).json()) as Recording;
    const steps = mergeEvents(recording.events);
    console.log(steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join("\n"));

    expect(steps.map((s) => s.kind)).toEqual(["switchTab", "click", "copy", "switchTab", "fill", "click"]);
    const [start, share, copy, , fill, download] = steps;
    expect(start).toMatchObject({ initial: true, url: `${fixture.origin}/list.html` });
    expect(share).toMatchObject({ target: { role: "button", name: "Share" } });
    expect(copy).toMatchObject({ value: shareUrl, target: { role: "button", name: "Copy" } });
    expect(fill).toMatchObject({ value: shareUrl, fromStep: copy.id, target: { role: "textbox", name: "Paste link" } });
    expect(download).toMatchObject({ target: { role: "button", name: "Download" } });

    // Click steps carry the page-state inventory (for the editor) and a screenshot.
    const shareEvent = recording.events[share.events[0]];
    expect(shareEvent.inventory?.some((i) => i.fingerprint.href?.endsWith("/watch?v=vid4"))).toBe(true);
    expect(shareEvent.screenshotId).toBeTruthy();
    const shot = await fetch(`${API}/screenshots/${shareEvent.screenshotId}`);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
  } finally {
    await env.close();
    await fixture.close();
  }
});
