import { expect, test } from "@playwright/test";
import { type Recording, mergeEvents } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { API, launch } from "./harness.js";

// Playwright can't reload a command-line-loaded extension (it ends up disabled), so this
// simulates "tab open before the extension (re)loaded" by removing the tab's recorder.
test("re-injects the recorder into open tabs that lack one, without duplicating it", async () => {
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const { context, panel } = env;
    const stale = await context.newPage();
    await stale.goto(`${fixture.origin}/list.html`);
    const healthy = await context.newPage();
    await healthy.goto(`${fixture.origin}/form.html`);

    await panel.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: () => (globalThis as { __d2aDisposeRecorder?: () => void }).__d2aDisposeRecorder?.(),
      });
    }, `${fixture.origin}/list.html`);

    await stale.bringToFront();
    const rec = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "startRecording", name: "stale tab" }));
    await stale.waitForTimeout(300);
    await stale.getByRole("button", { name: "Share" }).first().click();
    await stale.getByRole("button", { name: "Copy" }).click();

    // The healthy tab was re-injected too; it must still record each action exactly once.
    await healthy.bringToFront();
    await healthy.getByLabel("Paste link").click();
    await healthy.keyboard.press("ControlOrMeta+V");
    await healthy.getByRole("button", { name: "Download" }).click();

    await panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopRecording" }));
    await stale.waitForTimeout(300);

    const recording = (await (await fetch(`${API}/recordings/${rec.id}`)).json()) as Recording;
    const steps = mergeEvents(recording.events);
    expect(steps.map((s) => s.kind)).toEqual(["switchTab", "click", "copy", "switchTab", "fill", "click"]);
    expect(steps[2]).toMatchObject({ value: `${fixture.origin}/share/vid1` });
    const counts = (type: string) => recording.events.filter((e) => e.event.type === type).length;
    expect({ clicks: counts("click"), pastes: counts("paste"), copies: counts("copy") }).toEqual({ clicks: 4, pastes: 1, copies: 1 });
  } finally {
    await env.close();
    await fixture.close();
  }
});
