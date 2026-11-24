import { z } from "zod";
import type { Target } from "./workflow.js";

export const RunOptions = z.object({
  /** Only run the first N items of each forEach (1 = dry run). */
  limit: z.number().int().positive().optional(),
  /** Pause between forEach items. */
  delayMs: z.number().int().nonnegative().default(500),
  /** Extra attempts per item before it is marked failed and skipped. */
  retries: z.number().int().nonnegative().default(1),
  /** Ask Claude to find a step's element when the page has changed, and save fixes that work. */
  heal: z.boolean().default(true),
});
export type RunOptions = z.infer<typeof RunOptions>;

export type RunStatus = "running" | "paused" | "stopped" | "done" | "failed";

export type ItemResult = {
  index: number;
  label: string;
  status: "pending" | "running" | "ok" | "failed";
  error?: string;
};

export type LogEntry = { ts: number; level: "info" | "warn" | "error"; message: string; stepId?: string; item?: number };

/** A step whose element was replaced during a run; saved into the workflow once the step worked. */
export type HealRecord = {
  ts: number;
  stepId: string;
  item?: number;
  from: Target;
  to: Target;
  reason: string;
  /** The user put the original element back. */
  reverted?: boolean;
};

export type RunSnapshot = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  options: RunOptions;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  items: ItemResult[];
  log: LogEntry[];
  heals: HealRecord[];
};
