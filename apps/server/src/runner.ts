import type {
  Command,
  CommandOf,
  CommandResults,
  Condition,
  ListItem,
  LogEntry,
  RunOptions,
  RunSnapshot,
  Step,
  Target,
  Workflow,
} from "@d2a/shared";
import { describeWorkflowStep } from "@d2a/shared";
import { render } from "./template.js";

export interface CommandExecutor {
  execute(command: Command, timeoutMs?: number): Promise<unknown>;
}

const WAIT_TIMEOUT_MS = 10_000;
const CLIPBOARD_TIMEOUT_MS = 5_000;
const POLL_MS = 200;
const CLICK_ATTEMPTS = 3;
/** Actions wait this long for their element to appear (pages render after "load"). */
const ACTION_WAIT_MS = 15_000;
const CLICK_EFFECT_TIMEOUT_MS = 3_000;
const MAX_LOG = 500;

class StopRequested extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Interprets a workflow, step by step, against the browser. One instance per run. */
export class Runner {
  readonly snapshot: RunSnapshot;
  private tabs = new Map<string, number>();
  private currentRole: string;
  private vars: Record<string, unknown> = {};
  private bindings: Record<string, ListItem> = {};
  private lastActionAt = 0;
  private stopRequested = false;
  private wake: (() => void) | undefined;

  constructor(
    id: string,
    private workflow: Workflow,
    private browser: CommandExecutor,
    private options: RunOptions,
    private onUpdate: (snapshot: RunSnapshot) => void,
  ) {
    this.currentRole = Object.keys(workflow.tabs)[0] ?? "main";
    this.snapshot = {
      id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "running",
      options,
      startedAt: Date.now(),
      items: [],
      log: [],
    };
  }

  async start(): Promise<RunSnapshot> {
    try {
      if (this.workflow.closePopups) {
        const allowedOrigins = Object.values(this.workflow.tabs).flatMap((t) => (t.startUrl ? [new URL(t.startUrl).origin] : []));
        await this.exec({ op: "setPopupPolicy", enabled: true, allowedOrigins });
      }
      for (const step of this.workflow.steps) await this.step(step);
      this.snapshot.status = "done";
      const failed = this.snapshot.items.filter((i) => i.status === "failed").length;
      this.log("info", failed ? `Finished with ${failed} failed item(s)` : "Finished");
    } catch (err) {
      if (err instanceof StopRequested) {
        this.snapshot.status = "stopped";
        this.log("warn", "Stopped");
      } else {
        this.snapshot.status = "failed";
        this.snapshot.error = (err as Error).message;
        this.log("error", `Failed: ${this.snapshot.error}`);
      }
    } finally {
      if (this.workflow.closePopups) await this.exec({ op: "setPopupPolicy", enabled: false, allowedOrigins: [] }).catch(() => {});
      for (const tabId of this.tabs.values()) await this.exec({ op: "release", tabId }).catch(() => {});
      this.snapshot.finishedAt = Date.now();
      this.update();
    }
    return this.snapshot;
  }

  /**
   * Runs only the steps before the first forEach (opening tabs, collecting lists) and reports what
   * the lists contain. Used to check a freshly compiled workflow against the live page.
   */
  async preview(sampleSize: number): Promise<{ lists: { name: string; count: number; sample: ListItem[] }[]; error?: string }> {
    let error: string | undefined;
    try {
      for (const step of this.workflow.steps) {
        if (step.kind === "forEach") break;
        await this.step(step);
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      for (const tabId of this.tabs.values()) await this.exec({ op: "release", tabId }).catch(() => {});
    }
    const lists = Object.entries(this.vars)
      .filter((entry): entry is [string, ListItem[]] => Array.isArray(entry[1]))
      .map(([name, items]) => ({ name, count: items.length, sample: items.slice(0, sampleSize) }));
    return { lists, error };
  }

  pause() {
    if (this.snapshot.status !== "running") return;
    this.snapshot.status = "paused";
    this.log("info", "Paused");
  }

  resume() {
    if (this.snapshot.status !== "paused") return;
    this.snapshot.status = "running";
    this.log("info", "Resumed");
    this.wake?.();
  }

  stop() {
    this.stopRequested = true;
    this.wake?.();
  }

  /** Checkpoint between steps: honors pause and stop. */
  private async gate() {
    while (this.snapshot.status === "paused" && !this.stopRequested) {
      await new Promise<void>((r) => (this.wake = r));
    }
    if (this.stopRequested) throw new StopRequested();
  }

  private update() {
    this.onUpdate(this.snapshot);
  }

  private log(level: LogEntry["level"], message: string, stepId?: string) {
    const item = Object.values(this.bindings).at(-1)?._index;
    this.snapshot.log.push({ ts: Date.now(), level, message, stepId, item });
    if (this.snapshot.log.length > MAX_LOG) this.snapshot.log.splice(0, this.snapshot.log.length - MAX_LOG);
    this.update();
  }

  private exec<K extends Command["op"]>(command: CommandOf<K>): Promise<CommandResults[K]> {
    return this.browser.execute(command) as Promise<CommandResults[K]>;
  }

  private render(template: string): string {
    return render(template, { ...this.vars, ...this.bindings, vars: this.vars });
  }

  private locator(target: Target) {
    if (!target.within) return { fingerprint: target.fingerprint };
    const item = this.bindings[target.within];
    if (!item) throw new Error(`target "${target.description}" is scoped to "${target.within}", which is not a current item`);
    return { fingerprint: target.fingerprint, within: item._selector };
  }

  private async tabFor(step: Step): Promise<number> {
    const role = step.tab ?? this.currentRole;
    const tabId = this.tabs.get(role);
    if (tabId !== undefined) return tabId;
    await this.switchTab(role);
    return this.tabs.get(role)!;
  }

  private async switchTab(role: string, url?: string) {
    const known = this.tabs.get(role);
    if (known !== undefined) {
      try {
        await this.exec({ op: "activateTab", tabId: known });
        this.currentRole = role;
        return;
      } catch {
        this.tabs.delete(role); // the tab was closed
      }
    }
    const startUrl = url ? this.render(url) : this.workflow.tabs[role]?.startUrl;
    if (!startUrl) throw new Error(`no open tab for "${role}" and no URL to open one`);
    const { tabId: found } = await this.exec({ op: "findTab", urlPrefix: startUrl });
    let tabId: number;
    if (found !== null) {
      tabId = found;
      await this.exec({ op: "activateTab", tabId });
    } else {
      tabId = (await this.exec({ op: "openTab", url: startUrl })).tabId;
    }
    this.tabs.set(role, tabId);
    this.currentRole = role;
  }

  private async act(tabId: number, command: Command): Promise<unknown> {
    this.lastActionAt = Date.now();
    const result = await this.browser.execute(command);
    const { closedPopups } = await this.exec({ op: "settle", tabId });
    for (const host of closedPopups) this.log("info", `closed a tab the page opened (${host})`);
    return result;
  }

  /** Makes a tab the given role's tab and continues there. */
  private adoptTab(role: string, tabId: number) {
    this.tabs.set(role, tabId);
    this.currentRole = role;
  }

  private async step(step: Step): Promise<void> {
    await this.gate();
    if (step.kind !== "forEach") this.log("info", describeWorkflowStep(step), step.id);

    switch (step.kind) {
      case "switchTab":
        return this.switchTab(step.role, step.url);
      case "openTab": {
        const { tabId } = await this.exec({ op: "openTab", url: this.render(step.url) });
        return this.adoptTab(step.role, tabId);
      }
      case "closeTab": {
        const tabId = this.tabs.get(step.role);
        if (tabId === undefined) return this.log("warn", `no ${step.role} tab to close`, step.id);
        this.tabs.delete(step.role);
        await this.exec({ op: "closeTab", tabId }).catch(() => {}); // already closed is fine
        if (this.currentRole === step.role) this.currentRole = this.tabs.keys().next().value ?? this.currentRole;
        return;
      }
      case "navigate": {
        const tabId = await this.tabFor(step);
        this.lastActionAt = Date.now();
        return void (await this.exec({ op: "navigate", tabId, url: this.render(step.url) }));
      }
      case "click": {
        const tabId = await this.tabFor(step);
        const click = async () => {
          await this.waitForTarget(tabId, step.target);
          const locator = this.locator(step.target);
          const result = (await this.act(tabId, { op: "click", tabId, locator, expectNewTab: Boolean(step.opensTab) })) as CommandResults["click"];
          if (step.opensTab && result.newTabId !== null) this.adoptTab(step.opensTab, result.newTabId);
        };
        // A click that opens a tab is confirmed by the tab itself; `until` would look in the wrong tab.
        if (!step.until || step.opensTab) return click();
        let detail = "";
        for (let attempt = 1; attempt <= CLICK_ATTEMPTS; attempt++) {
          // Re-check first so a slow-but-successful click is never repeated.
          if (attempt > 1 && (await this.check(tabId, step.until)).met) return;
          if (attempt > 1) this.log("warn", `click had no visible effect (${detail}); clicking again`, step.id);
          await click();
          const result = await this.waitUntil(tabId, step.until, CLICK_EFFECT_TIMEOUT_MS);
          if (result.met) return;
          detail = result.detail;
        }
        throw new Error(`clicking ${step.target.description} had no effect after ${CLICK_ATTEMPTS} tries: ${detail}`);
      }
      case "fill": {
        const tabId = await this.tabFor(step);
        await this.waitForTarget(tabId, step.target);
        await this.act(tabId, { op: "fill", tabId, locator: this.locator(step.target), value: this.render(step.value) });
        return;
      }
      case "press": {
        const tabId = await this.tabFor(step);
        if (step.target) await this.waitForTarget(tabId, step.target);
        await this.act(tabId, { op: "press", tabId, key: step.key, locator: step.target && this.locator(step.target) });
        return;
      }
      case "waitFor": {
        const tabId = await this.tabFor(step);
        const result = await this.waitUntil(tabId, step, step.timeoutMs ?? WAIT_TIMEOUT_MS);
        if (!result.met) throw new Error(`timed out waiting for ${step.target?.description ?? step.urlMatches}: ${result.detail}`);
        return;
      }
      case "assert": {
        if (!step.target) return; // free-form conditions are checked by the compiler/healer, not here
        const tabId = await this.tabFor(step);
        const probe = await this.exec({ op: "probe", tabId, locator: this.locator(step.target) });
        if (!probe.found) throw new Error(`check failed: ${step.condition} (${probe.error})`);
        return;
      }
      case "extract": {
        const tabId = await this.tabFor(step);
        await this.waitForTarget(tabId, step.target);
        this.vars[step.name] = await this.exec({ op: "extract", tabId, locator: this.locator(step.target), attr: step.attr });
        return;
      }
      case "extractList": {
        const tabId = await this.tabFor(step);
        const items = await this.exec({
          op: "extractList", tabId, itemSelector: step.itemSelector, fields: step.fields,
          container: step.container && this.locator(step.container),
        });
        this.vars[step.name] = items;
        this.log("info", `Found ${items.length} ${step.name}`, step.id);
        return;
      }
      case "copyFromClipboard":
        this.vars[step.name] = await this.copied(await this.tabFor(step));
        return;
      case "forEach":
        return this.forEach(step);
    }
  }

  /** Waits for an element an action needs; fails with why it wasn't found. */
  private async waitForTarget(tabId: number, target: Target) {
    const result = await this.waitUntil(tabId, { target }, ACTION_WAIT_MS);
    if (!result.met) throw new Error(`${result.detail} (waited ${ACTION_WAIT_MS / 1000}s)`);
  }

  /** Evaluates a condition once. */
  private async check(tabId: number, cond: Condition): Promise<{ met: boolean; detail: string }> {
    if (cond.target) {
      const text = cond.textIncludes && this.render(cond.textIncludes);
      const probe = await this.exec({ op: "probe", tabId, locator: this.locator(cond.target), textIncludes: text || undefined });
      if (probe.found && (!text || probe.textMatched)) return { met: true, detail: "" };
      return { met: false, detail: probe.found ? `text was "${probe.text?.slice(0, 80)}"` : (probe.error ?? "") };
    }
    if (cond.urlMatches) {
      const { url } = await this.exec({ op: "tabInfo", tabId });
      return { met: new RegExp(cond.urlMatches).test(url), detail: `url was ${url}` };
    }
    return { met: true, detail: "" };
  }

  private async waitUntil(tabId: number, cond: Condition, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await this.gate();
      const result = await this.check(tabId, cond);
      if (result.met || Date.now() >= end) return result;
      await sleep(POLL_MS);
    }
  }

  /** The value copied by the previous action, read from the tab's copy tracker. */
  private async copied(tabId: number): Promise<string> {
    const end = Date.now() + CLIPBOARD_TIMEOUT_MS;
    while (Date.now() < end) {
      const last = await this.exec({ op: "lastCopied", tabId });
      if (last && last.ts >= this.lastActionAt - 50) return last.value;
      await sleep(POLL_MS);
    }
    throw new Error("nothing was copied by the previous step");
  }

  private async forEach(step: Extract<Step, { kind: "forEach" }>) {
    const list = this.vars[step.list];
    if (!Array.isArray(list)) throw new Error(`"${step.list}" is not a list; was it collected first?`);
    const items = (list as ListItem[]).slice(0, this.options.limit ?? list.length);
    const label = (it: ListItem, i: number) =>
      String(Object.entries(it).find(([k, v]) => !k.startsWith("_") && typeof v === "string" && v)?.[1] ?? `#${i + 1}`).slice(0, 80);
    this.snapshot.items = items.map((it, i) => ({ index: i, label: label(it, i), status: "pending" }));
    this.log("info", `${describeWorkflowStep(step)}: ${items.length} of ${list.length}`, step.id);

    for (const [i, item] of items.entries()) {
      await this.gate();
      const result = this.snapshot.items[i];
      result.status = "running";
      this.bindings[step.as] = item;
      for (let attempt = 0; ; attempt++) {
        try {
          for (const inner of step.body) await this.step(inner);
          result.status = "ok";
          break;
        } catch (err) {
          if (err instanceof StopRequested) throw err;
          const message = (err as Error).message;
          if (attempt < this.options.retries) {
            this.log("warn", `Item ${i + 1} failed (${message}); retrying`);
            continue;
          }
          result.status = "failed";
          result.error = message;
          this.log("error", `Item ${i + 1} failed: ${message}; skipping`);
          break;
        }
      }
      this.update();
      if (i < items.length - 1) await sleep(this.options.delayMs);
    }
    delete this.bindings[step.as];
  }
}
