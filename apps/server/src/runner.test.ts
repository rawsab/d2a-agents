import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Command, type HealRecord, RunOptions, type Target, type Workflow, findStep } from "@d2a/shared";
import type { HealDecision, HealRequest, Healer } from "./healer.js";
import { type CommandExecutor, Runner } from "./runner.js";

type El = { role: string; name: string; css: string };

/** A one-tab page whose elements are found by role and name; records the clicks it gets. */
class FakePage implements CommandExecutor {
  clicks: string[] = [];
  constructor(public elements: El[]) {}

  private find(fp: { role?: string; name?: string }) {
    return this.elements.find((e) => e.role === fp.role && e.name === fp.name);
  }

  async execute(cmd: Command): Promise<unknown> {
    switch (cmd.op) {
      case "findTab":
        return { tabId: 1 };
      case "tabInfo":
        return { url: "https://example.test/", title: "Example" };
      case "probe": {
        const el = this.find(cmd.locator.fingerprint);
        return el ? { found: true, text: el.name } : { found: false, error: `no visible element matches ${cmd.locator.fingerprint.name}` };
      }
      case "click": {
        const el = this.find(cmd.locator.fingerprint);
        if (!el) throw new Error("not found");
        this.clicks.push(el.name);
        if (el.name === "Accept cookies") this.elements = this.elements.filter((e) => e !== el).concat(hiddenByBanner);
        return { newTabId: null };
      }
      case "snapshot":
        return this.elements.map((e) => ({ tag: "button", fingerprint: { role: e.role, name: e.name, css: e.css, bbox: { x: 0, y: 0, w: 1, h: 1 } } }));
      case "screenshot":
        return { data: "AAAA" };
      case "settle":
        return { closedPopups: [] };
      default:
        return null;
    }
  }
}

const hiddenByBanner: El = { role: "button", name: "Download", css: "#dl" };

class FakeHealer implements Healer {
  requests: HealRequest[] = [];
  constructor(private answers: HealDecision[]) {}
  async decide(req: HealRequest) {
    this.requests.push(req);
    return this.answers.shift() ?? { action: "giveUp", elementIndex: null, reason: "out of answers" };
  }
}

const download: Target = { description: "Download button", fingerprint: { role: "button", name: "Download", css: "form > button.stale" } };

function workflow(steps: Workflow["steps"]): Workflow {
  return { id: "wf", name: "test", tabs: { main: { startUrl: "https://example.test/" } }, steps };
}

async function run(wf: Workflow, page: FakePage, healer?: Healer) {
  const saved: HealRecord[] = [];
  const runner = new Runner("run", wf, page, RunOptions.parse({ delayMs: 0, retries: 0 }), () => {},
    healer && { healer, save: (heal) => saved.push(heal) });
  const done = runner.start();
  await vi.runAllTimersAsync();
  return { snapshot: await done, saved };
}

describe("healing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retargets a relabelled button, clicks it, and saves the new element", async () => {
    const page = new FakePage([{ role: "button", name: "Help", css: "#help" }, { role: "button", name: "Get it", css: "form > button" }]);
    const healer = new FakeHealer([{ action: "retarget", elementIndex: 1, reason: "Download was renamed Get it" }]);
    const wf = workflow([{ id: "s1", kind: "click", target: download }]);
    const { snapshot, saved } = await run(wf, page, healer);

    expect(snapshot.status).toBe("done");
    expect(page.clicks).toEqual(["Get it"]);
    expect(healer.requests[0]).toMatchObject({ step: "click Download button", target: { name: "Download" }, withinItem: false, screenshot: "AAAA" });
    expect(saved).toHaveLength(1);
    expect(saved[0].from).toEqual(download);
    // The page-specific bbox isn't kept; the description is.
    expect(saved[0].to).toEqual({ description: "Download button", fingerprint: { role: "button", name: "Get it", css: "form > button" } });
    expect(snapshot.heals).toEqual(saved);
  });

  it("clicks what covers the element first, then uses the original element", async () => {
    const page = new FakePage([{ role: "button", name: "Accept cookies", css: "#cookies" }]);
    const healer = new FakeHealer([{ action: "clickFirst", elementIndex: 0, reason: "a cookie banner covers the page" }]);
    const { snapshot, saved } = await run(workflow([{ id: "s1", kind: "click", target: download }]), page, healer);

    expect(snapshot.status).toBe("done");
    expect(page.clicks).toEqual(["Accept cookies", "Download"]);
    expect(saved).toEqual([]); // nothing to change in the workflow
  });

  it("tells the healer when its answer didn't work, and fails with both reasons when it gives up", async () => {
    const page = new FakePage([{ role: "button", name: "Help", css: "#help" }]);
    const healer = new FakeHealer([
      { action: "retarget", elementIndex: 7, reason: "guess" },
      { action: "giveUp", elementIndex: null, reason: "there is no download control" },
    ]);
    const { snapshot } = await run(workflow([{ id: "s1", kind: "click", target: download }]), page, healer);

    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toContain("no visible element matches Download");
    expect(snapshot.error).toContain("there is no download control");
    expect(healer.requests[1].rejected).toEqual(["retarget [7]: there is no such element"]);
    expect(page.clicks).toEqual([]);
  });

  it("puts the original element back when the step still fails with the replacement", async () => {
    const page = new FakePage([{ role: "button", name: "Get it", css: "form > button" }]);
    const healer = new FakeHealer([{ action: "retarget", elementIndex: 0, reason: "renamed" }]);
    const status: Target = { description: "status", fingerprint: { role: "status", name: "Queued" } };
    const wf = workflow([{ id: "s1", kind: "click", target: download, until: { target: status } }]);
    const { snapshot, saved } = await run(wf, page, healer);

    expect(snapshot.status).toBe("failed");
    expect(saved).toEqual([]);
    expect(findStep(wf.steps, "s1")).toMatchObject({ target: download });
  });

  it("inside a list item keeps only the parts of the new element that fit every item", async () => {
    const page = new FakePage([{ role: "button", name: "Share it", css: "#playlist > li:nth-of-type(1) > button" }]);
    const execute = page.execute.bind(page);
    page.execute = async (cmd) =>
      cmd.op === "extractList" ? [{ _index: 0, _selector: "#playlist > li:nth-of-type(1)", title: "One" }] : execute(cmd);
    const healer = new FakeHealer([{ action: "retarget", elementIndex: 0, reason: "renamed" }]);
    const share: Target = { description: "Share button", within: "video", fingerprint: { role: "button", name: "Share" } };
    const wf = workflow([
      { id: "s1", kind: "extractList", name: "videos", itemSelector: "li", fields: {} },
      { id: "s2", kind: "forEach", list: "videos", as: "video", body: [{ id: "s2.1", kind: "click", target: share }] },
    ]);
    const { snapshot, saved } = await run(wf, page, healer);

    expect(snapshot.items.map((i) => i.status)).toEqual(["ok"]);
    expect(healer.requests[0].withinItem).toBe(true);
    expect(saved[0]).toMatchObject({ item: 0, to: { within: "video", fingerprint: { role: "button", name: "Share it" } } });
    expect(saved[0].to.fingerprint.css).toBeUndefined();
  });

  it("without a healer, a missing element fails the step as before", async () => {
    const page = new FakePage([]);
    const { snapshot } = await run(workflow([{ id: "s1", kind: "click", target: download }]), page);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toBe("no visible element matches Download (waited 15s)");
  });
});
