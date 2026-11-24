import { z } from "zod";
import { Fingerprint } from "./events.js";

/** An element to act on: locator candidates plus a description used for healing. */
export const Target = z.object({
  description: z.string(),
  fingerprint: Fingerprint,
});
export type Target = z.infer<typeof Target>;

/** Template string; supports {{item.field}} and {{vars.name}}. */
const Expr = z.string();
const TabRole = z.string();

const stepBase = { id: z.string(), tab: TabRole.optional() };

export type Step =
  | { id: string; tab?: string; kind: "navigate"; url: string }
  | { id: string; tab?: string; kind: "switchTab"; role: string; url?: string }
  | { id: string; tab?: string; kind: "click"; target: Target }
  | { id: string; tab?: string; kind: "fill"; target: Target; value: string }
  | { id: string; tab?: string; kind: "press"; key: string; target?: Target }
  | { id: string; tab?: string; kind: "waitFor"; target?: Target; urlMatches?: string; networkIdle?: boolean; timeoutMs?: number }
  | { id: string; tab?: string; kind: "extract"; name: string; target: Target; attr?: string }
  | { id: string; tab?: string; kind: "extractList"; name: string; container: Target; item: Target; fields: Record<string, { selector?: string; attr?: string }> }
  | { id: string; tab?: string; kind: "copyFromClipboard"; name: string }
  | { id: string; tab?: string; kind: "forEach"; list: string; as: string; body: Step[] }
  | { id: string; tab?: string; kind: "assert"; target?: Target; condition: string };

export const Step: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ ...stepBase, kind: z.literal("navigate"), url: Expr }),
    z.object({ ...stepBase, kind: z.literal("switchTab"), role: TabRole, url: Expr.optional() }),
    z.object({ ...stepBase, kind: z.literal("click"), target: Target }),
    z.object({ ...stepBase, kind: z.literal("fill"), target: Target, value: Expr }),
    z.object({ ...stepBase, kind: z.literal("press"), key: z.string(), target: Target.optional() }),
    z.object({
      ...stepBase,
      kind: z.literal("waitFor"),
      target: Target.optional(),
      urlMatches: z.string().optional(),
      networkIdle: z.boolean().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.object({ ...stepBase, kind: z.literal("extract"), name: z.string(), target: Target, attr: z.string().optional() }),
    z.object({
      ...stepBase,
      kind: z.literal("extractList"),
      name: z.string(),
      container: Target,
      item: Target,
      fields: z.record(z.object({ selector: z.string().optional(), attr: z.string().optional() })),
    }),
    z.object({ ...stepBase, kind: z.literal("copyFromClipboard"), name: z.string() }),
    z.object({ ...stepBase, kind: z.literal("forEach"), list: z.string(), as: z.string(), body: z.array(Step) }),
    z.object({ ...stepBase, kind: z.literal("assert"), target: Target.optional(), condition: z.string() }),
  ]),
);

export const Workflow = z.object({
  id: z.string(),
  name: z.string(),
  recordingId: z.string().optional(),
  instruction: z.string().optional(),
  /** Tab roles and the URL each should start on if not already open. */
  tabs: z.record(z.object({ startUrl: z.string().optional() })),
  steps: z.array(Step),
});
export type Workflow = z.infer<typeof Workflow>;
