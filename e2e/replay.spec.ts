import { expect, test } from "@playwright/test";
import { startFixtureServer } from "../fixtures/server.js";
import { fixtureWorkflow } from "../fixtures/workflow.js";
import { API, launch, runWorkflow, until } from "./harness.js";

type Env = Awaited<ReturnType<typeof launch>>;
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let env: Env;

test.beforeEach(async () => {
  fixture = await startFixtureServer();
  env = await launch();
});
test.afterEach(async () => {
  await env.close();
  await fixture.close();
});

const shareUrls = (ids: number[]) => ids.map((i) => `${fixture.origin}/share/vid${i}`);

test("replays the workflow for every playlist item, opening the tabs it needs", async () => {
  const run = await runWorkflow(fixtureWorkflow(fixture.origin), { delayMs: 0 });
  if (run.status !== "done") console.log(run.log.map((l) => `${l.level}: ${l.message}`).join("\n"));
  expect(run.status).toBe("done");
  expect(run.items.map((i) => [i.label, i.status])).toEqual([
    ["Video One", "ok"], ["Video Two", "ok"], ["Video Three", "ok"], ["Video Four", "ok"],
  ]);
  expect(fixture.log).toEqual(shareUrls([1, 2, 3, 4]));
});

test("a click the page ignores (still loading) is retried until its expected result appears", async () => {
  const run = await runWorkflow(fixtureWorkflow(fixture.origin, "?slow=2000"), { delayMs: 0 });
  expect(run.status).toBe("done");
  expect(run.log.some((l) => l.message.startsWith("click had no visible effect"))).toBe(true);
  expect(fixture.log).toEqual(shareUrls([1, 2, 3, 4]));
});

test("actions wait for their element when the page renders it after loading", async () => {
  const run = await runWorkflow(fixtureWorkflow(fixture.origin, "?hidden=2000"), { delayMs: 0 });
  expect(run.status).toBe("done");
  expect(fixture.log).toEqual(shareUrls([1, 2, 3, 4]));
});

test("closePopups closes the ad tabs a page opens and the run carries on", async () => {
  const run = await runWorkflow({ ...fixtureWorkflow(fixture.origin, "", "?ads=1"), closePopups: true }, { delayMs: 0 });
  expect(run.status).toBe("done");
  expect(fixture.log).toEqual(shareUrls([1, 2, 3, 4]));
  expect(run.log.filter((l) => l.message.startsWith("closed a tab the page opened (localhost"))).toHaveLength(4);
  expect(env.context.pages().some((p) => p.url().includes("/ad.html"))).toBe(false);
});

test("a dry run only does the first item", async () => {
  const run = await runWorkflow(fixtureWorkflow(fixture.origin), { limit: 1 });
  expect(run.status).toBe("done");
  expect(fixture.log).toEqual(shareUrls([1]));
});

test("a failing item is retried, then skipped, and the rest still run", async () => {
  const list = await env.context.newPage();
  await list.goto(`${fixture.origin}/list.html`);
  await list.evaluate(() => document.querySelectorAll(".share")[2].remove()); // item 3 can't be shared

  const run = await runWorkflow(fixtureWorkflow(fixture.origin), { delayMs: 0, retries: 1 });
  expect(run.status).toBe("done");
  expect(run.items.map((i) => i.status)).toEqual(["ok", "ok", "failed", "ok"]);
  expect(run.items[2].error).toContain('no visible element matches button "Share"');
  expect(run.log.some((l) => l.message.startsWith("Item 3 failed") && l.message.includes("retrying"))).toBe(true);
  expect(fixture.log).toEqual(shareUrls([1, 2, 4]));
});

test("pause holds the run between steps; stop ends it", async () => {
  const run = await runWorkflow(fixtureWorkflow(fixture.origin), { delayMs: 300 }, async (started) => {
    const control = (action: string) => fetch(`${API}/runs/${started.id}/${action}`, { method: "POST" });
    await until(async () => fixture.log.length >= 1, "first item");
    await control("pause");
    const pausedAt = fixture.log.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(fixture.log.length).toBeLessThanOrEqual(pausedAt + 1); // at most the in-flight step completes
    await control("resume");
    await until(async () => fixture.log.length >= 3, "third item");
    await control("stop");
  });
  expect(run.status).toBe("stopped");
  expect(fixture.log.length).toBeLessThan(4);
});
