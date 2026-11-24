import { z } from "zod";
import { Fingerprint } from "./events.js";

/** An element to act on: locator candidates plus a description used for healing. */
export const Target = z.object({
  description: z.string(),
  fingerprint: Fingerprint,
  /** Name of a forEach item; the element is looked up inside that list item only. */
  within: z.string().optional(),
});
export type Target = z.infer<typeof Target>;

/** Something observable on the page: an element (optionally containing text), or a URL pattern. */
export type Condition = { target?: Target; textIncludes?: string; urlMatches?: string };
export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.object({ target: Target.optional(), textIncludes: z.string().optional(), urlMatches: z.string().optional() }),
);

/** Template string; supports {{item.field}} and {{vars.name}}. */
const Expr = z.string();
const TabRole = z.string();

const stepBase = { id: z.string(), tab: TabRole.optional() };

/** A value read from each list item: `selector` within the item (default: the item), `attr` (default: text). */
export const ListField = z.object({ selector: z.string().optional(), attr: z.string().optional() });
export type ListField = z.infer<typeof ListField>;

export type Step =
  | { id: string; tab?: string; kind: "navigate"; url: string }
  | { id: string; tab?: string; kind: "switchTab"; role: string; url?: string }
  | { id: string; tab?: string; kind: "click"; target: Target; until?: Condition }
  | { id: string; tab?: string; kind: "fill"; target: Target; value: string }
  | { id: string; tab?: string; kind: "press"; key: string; target?: Target }
  | { id: string; tab?: string; kind: "waitFor"; target?: Target; textIncludes?: string; urlMatches?: string; timeoutMs?: number }
  | { id: string; tab?: string; kind: "extract"; name: string; target: Target; attr?: string }
  | { id: string; tab?: string; kind: "extractList"; name: string; container?: Target; itemSelector: string; fields: Record<string, ListField> }
  | { id: string; tab?: string; kind: "copyFromClipboard"; name: string }
  | { id: string; tab?: string; kind: "forEach"; list: string; as: string; body: Step[] }
  | { id: string; tab?: string; kind: "assert"; target?: Target; condition: string };

export const Step: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ ...stepBase, kind: z.literal("navigate"), url: Expr }),
    z.object({ ...stepBase, kind: z.literal("switchTab"), role: TabRole, url: Expr.optional() }),
    z.object({
      ...stepBase,
      kind: z.literal("click"),
      target: Target,
      /** Expected result; if it doesn't appear, the click is retried (pages often ignore clicks while loading). */
      until: Condition.optional(),
    }),
    z.object({ ...stepBase, kind: z.literal("fill"), target: Target, value: Expr }),
    z.object({ ...stepBase, kind: z.literal("press"), key: z.string(), target: Target.optional() }),
    z.object({
      ...stepBase,
      kind: z.literal("waitFor"),
      target: Target.optional(),
      textIncludes: Expr.optional(),
      urlMatches: z.string().optional(),
      timeoutMs: z.number().optional(),
    }),
    z.object({ ...stepBase, kind: z.literal("extract"), name: z.string(), target: Target, attr: z.string().optional() }),
    z.object({
      ...stepBase,
      kind: z.literal("extractList"),
      name: z.string(),
      container: Target.optional(),
      /** CSS selector for each item, relative to the container (or the document). */
      itemSelector: z.string(),
      fields: z.record(ListField),
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
  /** Close tabs that pages open on other sites (ads, pop-unders) as soon as they appear. */
  closePopups: z.boolean().optional(),
  /** What the compiler reported alongside the workflow, for review. */
  notes: z
    .object({
      summary: z.string(),
      excludedSteps: z.array(z.object({ step: z.string(), reason: z.string() })),
      assumptions: z.array(z.string()),
      questions: z.array(z.string()),
      /** Unresolved problems; the workflow likely won't run until they're fixed. */
      problems: z.array(z.string()),
    })
    .optional(),
});
export type Workflow = z.infer<typeof Workflow>;

/** One-line, plain-language description of a workflow step. */
export function describeWorkflowStep(step: Step): string {
  switch (step.kind) {
    case "navigate":
      return `go to ${step.url}`;
    case "switchTab":
      return `switch to ${step.role} tab`;
    case "click":
      return `click ${step.target.description}`;
    case "fill":
      return `fill ${step.target.description} with ${step.value}`;
    case "press":
      return `press ${step.key}`;
    case "waitFor":
      return `wait for ${step.target?.description ?? step.urlMatches ?? "condition"}`;
    case "extract":
      return `read ${step.name} from ${step.target.description}`;
    case "extractList":
      return `collect ${step.name} (${step.itemSelector})`;
    case "copyFromClipboard":
      return `take copied value as ${step.name}`;
    case "forEach":
      return `for each ${step.as} in ${step.list}`;
    case "assert":
      return `check ${step.condition}`;
  }
}
