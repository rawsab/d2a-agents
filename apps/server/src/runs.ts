import { randomUUID } from "node:crypto";
import { RunOptions, type RunSnapshot, type Workflow } from "@d2a/shared";
import { type CommandExecutor, Runner } from "./runner.js";
import type { Store } from "./store.js";

const SAVE_INTERVAL_MS = 1000;

/** Owns the single active run (there is one browser) and persists snapshots as it progresses. */
export class RunManager {
  private active: Runner | undefined;

  constructor(private store: Store, private browser: CommandExecutor) {}

  get current(): RunSnapshot | undefined {
    return this.active?.snapshot;
  }

  start(workflow: Workflow, rawOptions: unknown): RunSnapshot {
    if (this.active) throw new Error("another run is in progress");
    const options = RunOptions.parse(rawOptions ?? {});
    let lastSave = 0;
    const runner = new Runner(randomUUID(), workflow, this.browser, options, (snap) => {
      // Throttle writes; the final snapshot is always saved below.
      if (Date.now() - lastSave > SAVE_INTERVAL_MS) {
        lastSave = Date.now();
        this.store.saveRun(snap);
      }
    });
    this.active = runner;
    this.store.saveRun(runner.snapshot);
    runner.start().then((final) => {
      this.store.saveRun(final);
      if (this.active === runner) this.active = undefined;
    });
    return runner.snapshot;
  }

  /** Checks a workflow's setup steps against the live page (no forEach body runs). */
  async preview(workflow: Workflow, sampleSize: number) {
    if (this.active) throw new Error("another run is in progress");
    const runner = new Runner(randomUUID(), workflow, this.browser, RunOptions.parse({}), () => {});
    return runner.preview(sampleSize);
  }

  control(id: string, action: "pause" | "resume" | "stop"): boolean {
    if (this.active?.snapshot.id !== id) return false;
    this.active[action]();
    return true;
  }
}
