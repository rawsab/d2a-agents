import * as z from "zod/v4";

/**
 * What Claude returns, as JSON validated against this schema. It is flat (one loop level, arrays
 * instead of maps) and convert.ts turns it into a Workflow. Elements are referenced by recorded
 * step id rather than restated, so selectors come from the recording, not from the model.
 * (Constrained decoding isn't used: this schema's grammar is too large for structured outputs.)
 */
export const TargetRef = z.object({
  description: z.string().describe("What the element is, in plain words, e.g. \"this video's Share button\""),
  fromStep: z
    .string()
    .nullish()
    .describe("Recorded step id whose target this is, or whose page inventory inventoryIndex points into"),
  inventoryIndex: z
    .number()
    .int()
    .nullish()
    .describe("Index into fromStep's page inventory, for an element the user did not act on"),
  role: z.string().nullish().describe("ARIA role; overrides or replaces the recorded one"),
  name: z.string().nullish().describe("Accessible name; overrides or replaces the recorded one"),
  css: z.string().nullish().describe("CSS selector; overrides or replaces the recorded one"),
  withinItem: z.boolean().default(false).describe("Look for the element only inside the current loop item"),
});
export type TargetRef = z.infer<typeof TargetRef>;

export const ConditionRef = z.object({
  target: TargetRef.nullish(),
  textIncludes: z.string().nullish(),
  urlMatches: z.string().nullish().describe("Regular expression the tab URL must match"),
});

const ListFieldRef = z.object({
  name: z.string(),
  selector: z.string().nullish().describe("CSS selector inside each item; null for the item itself"),
  attr: z.string().nullish().describe("Attribute or property to read (e.g. href); null for text"),
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

/** Every field a step of any kind may use; a kind's unused fields are omitted. */
const stepFields = {
  id: z.string(),
  basedOn: z.array(z.string()).default([]).describe("Recorded step ids this step reproduces; empty for new steps"),
  tab: z.string().nullish().describe("Tab role: the tab to act in, or for switchTab the tab to switch to"),
  url: z.string().nullish(),
  target: TargetRef.nullish(),
  until: ConditionRef.nullish().describe("For click: what should appear afterwards; the click is retried if it doesn't"),
  value: z.string().nullish(),
  key: z.string().nullish(),
  textIncludes: z.string().nullish(),
  urlMatches: z.string().nullish(),
  timeoutMs: z.number().int().nullish(),
  name: z.string().nullish().describe("Variable name for extract, extractList and copyFromClipboard"),
  attr: z.string().nullish(),
  container: TargetRef.nullish(),
  itemSelector: z.string().nullish(),
  fields: z.array(ListFieldRef).nullish(),
  condition: z.string().nullish(),
};

export const InnerStep = z.object({ ...stepFields, kind: z.enum(INNER_KINDS) });
export type InnerStep = z.infer<typeof InnerStep>;

export const TopStep = z.object({
  ...stepFields,
  kind: z.enum([...INNER_KINDS, "forEach"]),
  list: z.string().nullish().describe("forEach: name of the list variable"),
  as: z.string().nullish().describe("forEach: name for the current item"),
  body: z.array(InnerStep).nullish().describe("forEach: steps run for each item"),
});
export type TopStep = z.infer<typeof TopStep>;

export const CompiledWorkflow = z.object({
  name: z.string().describe("Short name for the automation"),
  summary: z.string().describe("Two or three sentences, for the user, on what the automation will do"),
  tabs: z.array(z.object({ role: z.string(), startUrl: z.string() })),
  steps: z.array(TopStep),
  excludedSteps: z
    .array(z.object({ step: z.string(), reason: z.string() }))
    .default([])
    .describe("Recorded steps deliberately left out, e.g. noise or one-off setup"),
  assumptions: z.array(z.string()).default([]).describe("Interpretations the user should know about"),
  questions: z.array(z.string()).default([]).describe("Ambiguities only the user can resolve; empty if none"),
});
export type CompiledWorkflow = z.infer<typeof CompiledWorkflow>;

/** JSON Schema for the system prompt. */
export const COMPILED_WORKFLOW_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(CompiledWorkflow, { io: "input" }));
