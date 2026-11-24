import * as z from "zod/v4";

/**
 * What Claude returns. Structured outputs don't allow recursive schemas or records, so this is a
 * flat shape (one loop level, arrays instead of maps, nullable instead of optional) that
 * convert.ts turns into a Workflow. Elements are referenced by recorded step id rather than
 * restated, so selectors come from the recording, not from the model.
 */
export const TargetRef = z.object({
  description: z.string().describe("What the element is, in plain words, e.g. \"this video's Share button\""),
  fromStep: z
    .string()
    .nullable()
    .describe("Recorded step id whose target this is, or whose page inventory inventoryIndex points into"),
  inventoryIndex: z
    .number()
    .int()
    .nullable()
    .describe("Index into fromStep's page inventory, for an element the user did not act on"),
  role: z.string().nullable().describe("ARIA role; overrides or replaces the recorded one"),
  name: z.string().nullable().describe("Accessible name; overrides or replaces the recorded one"),
  css: z.string().nullable().describe("CSS selector; overrides or replaces the recorded one"),
  withinItem: z.boolean().describe("Look for the element only inside the current loop item"),
});
export type TargetRef = z.infer<typeof TargetRef>;

export const ConditionRef = z.object({
  target: TargetRef.nullable(),
  textIncludes: z.string().nullable(),
  urlMatches: z.string().nullable().describe("Regular expression the tab URL must match"),
});

const ListFieldRef = z.object({
  name: z.string(),
  selector: z.string().nullable().describe("CSS selector inside each item; null for the item itself"),
  attr: z.string().nullable().describe("Attribute or property to read (e.g. href); null for text"),
});

const INNER_KINDS = [
  "navigate",
  "switchTab",
  "click",
  "fill",
  "press",
  "waitFor",
  "extract",
  "extractList",
  "copyFromClipboard",
  "assert",
] as const;

/** Every field a step of any kind may use; fields a kind doesn't use are null. */
const stepFields = {
  id: z.string(),
  basedOn: z.array(z.string()).describe("Recorded step ids this step reproduces; empty for new steps"),
  tab: z.string().nullable().describe("Tab role: the tab to act in, or for switchTab the tab to switch to"),
  url: z.string().nullable(),
  target: TargetRef.nullable(),
  until: ConditionRef.nullable().describe("For click: what should appear afterwards; the click is retried if it doesn't"),
  value: z.string().nullable(),
  key: z.string().nullable(),
  textIncludes: z.string().nullable(),
  urlMatches: z.string().nullable(),
  timeoutMs: z.number().int().nullable(),
  name: z.string().nullable().describe("Variable name for extract, extractList and copyFromClipboard"),
  attr: z.string().nullable(),
  container: TargetRef.nullable(),
  itemSelector: z.string().nullable(),
  fields: z.array(ListFieldRef).nullable(),
  condition: z.string().nullable(),
};

export const InnerStep = z.object({ ...stepFields, kind: z.enum(INNER_KINDS) });
export type InnerStep = z.infer<typeof InnerStep>;

export const TopStep = z.object({
  ...stepFields,
  kind: z.enum([...INNER_KINDS, "forEach"]),
  list: z.string().nullable().describe("forEach: name of the list variable"),
  as: z.string().nullable().describe("forEach: name for the current item"),
  body: z.array(InnerStep).nullable().describe("forEach: steps run for each item"),
});
export type TopStep = z.infer<typeof TopStep>;

export const CompiledWorkflow = z.object({
  name: z.string().describe("Short name for the automation"),
  summary: z.string().describe("Two or three sentences, for the user, on what the automation will do"),
  tabs: z.array(z.object({ role: z.string(), startUrl: z.string() })),
  steps: z.array(TopStep),
  excludedSteps: z
    .array(z.object({ step: z.string(), reason: z.string() }))
    .describe("Recorded steps deliberately left out, e.g. noise or one-off setup"),
  assumptions: z.array(z.string()).describe("Interpretations the user should know about"),
  questions: z.array(z.string()).describe("Ambiguities only the user can resolve; empty if none"),
});
export type CompiledWorkflow = z.infer<typeof CompiledWorkflow>;
