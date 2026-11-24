import type { launch } from "./harness.js";

type Env = Awaited<ReturnType<typeof launch>>;

/**
 * Records the share → copy → paste → download demonstration on the fixture site (video 2),
 * optionally with an accidental click first. Returns the recording id.
 */
export async function recordFixtureDemo(
  env: Env,
  origin: string,
  /** viaLink: reach the downloader with "Open downloader" (a new tab) instead of an open tab. */
  opts: { withNoise?: boolean; withAds?: boolean; viaLink?: boolean } = {},
): Promise<string> {
  const { context, panel } = env;
  const list = await context.newPage();
  await list.goto(`${origin}/list.html`);
  let form = opts.viaLink ? undefined : await context.newPage();
  await form?.goto(`${origin}/form.html${opts.withAds ? "?ads=1" : ""}`);

  await list.bringToFront();
  const rec = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "startRecording", name: "fixture demo" }));
  await list.waitForTimeout(300);
  if (opts.withNoise) {
    await list.getByRole("heading").click();
    await list.waitForTimeout(900);
  }
  await list.getByRole("button", { name: "Share" }).nth(1).click();
  await list.getByRole("button", { name: "Copy" }).click();
  await list.waitForTimeout(900);
  if (!form) {
    const opened = context.waitForEvent("page");
    await list.getByRole("link", { name: "Open downloader" }).click();
    form = await opened;
    await form.waitForLoadState();
    await form.waitForTimeout(300);
  }
  await form.bringToFront();
  await form.getByLabel("Paste link").click();
  await form.keyboard.press("ControlOrMeta+V");
  const ad = opts.withAds ? context.waitForEvent("page") : undefined;
  await form.getByRole("button", { name: "Download" }).click();
  if (ad) {
    // The user glances at the ad tab, closes it and goes back.
    const page = await ad;
    await page.waitForLoadState();
    await page.close();
    await form!.bringToFront();
  }
  await form.getByRole("status").getByText("Queued").waitFor();
  await form.waitForTimeout(1000);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopRecording" }));
  await list.waitForTimeout(300);
  return rec.id;
}
