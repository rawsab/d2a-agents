import { expect, test } from "@playwright/test";
import type { Workflow } from "@d2a/shared";
import { startFixtureServer } from "../fixtures/server.js";
import { youtubeWorkflow } from "../fixtures/workflow.js";
import { API, launch, runWorkflow } from "./harness.js";

const PLAYLIST = "https://www.youtube.com/watch?v=6TBIk2CTnjE&list=PLWm-zsvwLDDF16u3QX035IgdXkeIpATOU";

// Live check against real YouTube (network required): LIVE=1 pnpm test:e2e
test("YouTube playlist → fixture downloader", async () => {
  test.setTimeout(150_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const wf = youtubeWorkflow(PLAYLIST, `${fixture.origin}/form.html`);
    const run = await runWorkflow(wf, { limit: 3, delayMs: 0 }, undefined, 100_000);
    console.log(run.log.map((l) => `${l.level}: ${l.message}`).join("\n"));
    console.log("downloader received:", fixture.log);
    expect(run.items.map((i) => i.status)).toEqual(["ok", "ok", "ok"]);
  } finally {
    await env.close();
    await fixture.close();
  }
});

// Milestone 6: the whole path on real YouTube. Record one share → paste → download, have Claude
// compile it into a loop over the playlist, then run it. Calls Claude (needs ANTHROPIC_API_KEY).
test("YouTube: a recorded demonstration compiles into a playlist loop that runs", async () => {
  test.setTimeout(420_000);
  const fixture = await startFixtureServer();
  const env = await launch();
  try {
    const yt = await env.context.newPage();
    await yt.goto(PLAYLIST);
    const form = await env.context.newPage();
    await form.goto(`${fixture.origin}/form.html`);
    await yt.bringToFront();
    const share = yt.getByRole("button", { name: "Share" }).first();
    await share.waitFor();
    await yt.waitForTimeout(4000); // let the page hydrate before demonstrating

    const rec = await env.panel.evaluate(() => chrome.runtime.sendMessage({ type: "startRecording", name: "yt demo" }));
    await yt.waitForTimeout(500);
    await share.click();
    const copy = yt.getByRole("button", { name: "Copy" }).first();
    await copy.waitFor();
    await yt.waitForTimeout(500);
    await copy.click();
    await yt.waitForTimeout(1200);
    await form.bringToFront();
    await form.getByLabel("Paste link").click();
    await form.keyboard.press("ControlOrMeta+V");
    await form.getByRole("button", { name: "Download" }).click();
    await form.getByRole("status").getByText("Queued").waitFor();
    await form.waitForTimeout(1000);
    await env.panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopRecording" }));
    await yt.waitForTimeout(300);
    expect(fixture.log).toHaveLength(1);
    const demonstrated = fixture.log[0];
    expect(demonstrated).toMatch(/^https:\/\/youtu\.be\//);

    const res = await fetch(`${API}/recordings/${rec.id}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "Repeat this for every video in the playlist" }),
    });
    const body = (await res.json()) as { workflow: Workflow; preview: unknown; rounds: number; corrections: string[][]; error?: string };
    expect(res.ok, body.error).toBe(true);
    console.log(`compiled in ${body.rounds} round(s); corrections: ${JSON.stringify(body.corrections)}`);
    console.log(`preview: ${JSON.stringify(body.preview)}`);
    console.log(JSON.stringify(body.workflow, null, 2));
    expect(body.workflow.notes?.problems).toEqual([]);
    expect(body.workflow.steps.some((s) => s.kind === "forEach")).toBe(true);

    fixture.log.length = 0;
    const run = await runWorkflow(body.workflow, { limit: 3, delayMs: 0, retries: 1 }, undefined, 240_000);
    console.log(run.log.map((l) => `${l.level}: ${l.message}`).join("\n"));
    console.log("downloader received:", fixture.log);
    console.log("heals:", JSON.stringify(run.heals));
    expect(run.items.map((i) => i.status)).toEqual(["ok", "ok", "ok"]);
    // Three different videos' share links.
    expect(fixture.log).toHaveLength(3);
    expect(new Set(fixture.log.map((u) => new URL(u).pathname)).size).toBe(3);
    for (const url of fixture.log) expect(url).toMatch(/^https:\/\/youtu\.be\//);
  } finally {
    await env.close();
    await fixture.close();
  }
});
