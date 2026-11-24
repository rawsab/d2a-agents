import type { launch } from "./harness.js";

type Env = Awaited<ReturnType<typeof launch>>;

/**
 * Records the share → copy → paste → download demonstration on the fixture site (video 2),
 * optionally with an accidental click first. Returns the recording id.
 */
export async function recordFixtureDemo(env: Env, origin: string, opts: { withNoise?: boolean } = {}): Promise<string> {
  const { context, panel } = env;
  const list = await context.newPage();
  await list.goto(`${origin}/list.html`);
  const form = await context.newPage();
  await form.goto(`${origin}/form.html`);

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
  await form.bringToFront();
  await form.getByLabel("Paste link").click();
  await form.keyboard.press("ControlOrMeta+V");
  await form.getByRole("button", { name: "Download" }).click();
  await form.getByRole("status").getByText("Queued").waitFor();
  await form.waitForTimeout(1000);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopRecording" }));
  await list.waitForTimeout(300);
  return rec.id;
}
