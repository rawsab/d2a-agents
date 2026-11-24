import { randomUUID } from "node:crypto";
import { RunOptions, type RunSnapshot, type Target, type Workflow, findStep } from "@d2a/shared";
import type { Healer } from "./healer.js";
import { type CommandExecutor, Runner } from "./runner.js";
import type { Store } from "./store.js";

const SAVE_INTERVAL_MS = 1000;

/** Owns the single active run (there is one browser) and persists snapshots as it progresses. */
export class RunManager {
  private active: Runner | undefined;

  constructor(private store: Store, private browser: CommandExecutor, private healer?: Healer) {}

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
    }, options.heal && this.healer ? { healer: this.healer, save: (heal) => this.setTarget(workflow.id, heal.stepId, heal.from, heal.to) } : undefined);
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

  /**
   * Puts a healed step's original element back. Only once the run is over, and only if the
   * workflow still has the healed element (the user may have changed it since).
   */
  revertHeal(runId: string, index: number): { ok: true } | { error: string; status: number } {
    if (this.active?.snapshot.id === runId) return { error: "the run is still going", status: 409 };
    const run = this.store.getRun(runId);
    const heal = run?.heals?.[index];
    if (!run || !heal) return { error: "not found", status: 404 };
    if (heal.reverted) return { ok: true };
    if (!this.setTarget(run.workflowId, heal.stepId, heal.to, heal.from)) {
      return { error: "the workflow no longer has the healed element; it was changed or deleted since", status: 409 };
    }
    heal.reverted = true;
    this.store.saveRun(run);
    return { ok: true };
  }

  /** Replaces a stored step's target, if it is still `expected`. */
  private setTarget(workflowId: string, stepId: string, expected: Target, target: Target): boolean {
    const workflow = this.store.getWorkflow(workflowId);
    const step = workflow && findStep(workflow.steps, stepId);
    if (!step || !("target" in step) || JSON.stringify(step.target) !== JSON.stringify(expected)) return false;
    step.target = target;
    this.store.saveWorkflow(workflow);
    return true;
  }

  control(id: string, action: "pause" | "resume" | "stop"): boolean {
    if (this.active?.snapshot.id !== id) return false;
    this.active[action]();
    return true;
  }
}
