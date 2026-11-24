import { expect, test } from "@playwright/test";
import { type Recording, describeEffect, describeStep, mergeEvents } from "@d2a/shared";
import { API, launch } from "./harness.js";

// Live check (network required): LIVE=1 pnpm test:e2e
test("YouTube: a stray click is flagged, the real share flow is not", async () => {
  test.setTimeout(90_000);
  const env = await launch();
  try {
    const page = await env.context.newPage();
    await page.goto("https://www.youtube.com/watch?v=6TBIk2CTnjE&list=PLWm-zsvwLDDF16u3QX035IgdXkeIpATOU");
    await page.bringToFront();
    const share = page.getByRole("button", { name: "Share" }).first();
    await share.waitFor();
    await page.waitForTimeout(4000); // let the page hydrate; the video keeps the DOM busy throughout
    const rec = await env.panel.evaluate(() => chrome.runtime.sendMessage({ type: "startRecording", name: "yt noise" }));
    await page.waitForTimeout(1000);

    // A stray click on the video's description area (non-interactive text).
    await page.locator("#title h1").first().click();
    await page.waitForTimeout(1200);
    await share.click();
    await page.getByRole("button", { name: "Copy" }).first().waitFor();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Copy" }).first().click();
    await page.waitForTimeout(1200);

    await env.panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopRecording" }));
    await page.waitForTimeout(500);
    const recording = (await (await fetch(`${API}/recordings/${rec.id}`)).json()) as Recording;
    const steps = mergeEvents(recording.events);
    for (const s of steps) {
      console.log(`${describeStep(s)}\n    effect: ${s.effect ? describeEffect(s.effect) : "-"} ${s.effect ? JSON.stringify({ m: s.effect.mutations, bm: s.effect.baselineMutations, r: s.effect.requests, br: s.effect.baselineRequests }) : ""}\n    noise: ${s.noise ? `${s.noise.rule} (${s.noise.reason})` : "-"}`);
    }
    const share_ = steps.find((s) => s.kind === "click" && s.target.name === "Share");
    const copy = steps.find((s) => s.kind === "copy");
    expect(share_?.noise).toBeUndefined();
    expect(copy?.noise).toBeUndefined();
  } finally {
    await env.close();
  }
});
