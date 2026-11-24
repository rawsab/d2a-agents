import { z } from "zod";

export const RunOptions = z.object({
  /** Only run the first N items of each forEach (1 = dry run). */
  limit: z.number().int().positive().optional(),
  /** Pause between forEach items. */
  delayMs: z.number().int().nonnegative().default(500),
  /** Extra attempts per item before it is marked failed and skipped. */
  retries: z.number().int().nonnegative().default(1),
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
};
