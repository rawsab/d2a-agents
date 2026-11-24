import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { type ListItem, type Recording, type Workflow, mergeEvents } from "@d2a/shared";
import { toWorkflow } from "./convert.js";
import { SYSTEM_PROMPT, type ScreenshotLoader, buildContext, repairMessage } from "./prompt.js";
import { CompiledWorkflow } from "./schema.js";

export const COMPILER_MODEL = "claude-opus-5-5";
/** Correction rounds after the first answer, for conversion or live-page problems. */
const MAX_REPAIRS = 2;
/** List items returned by the live-page check, for the problems check and the review UI. */
export const SAMPLE_ITEMS = 3;

export class CompileError extends Error {}

export type ModelReply = { parsed: CompiledWorkflow | null; content: Anthropic.Beta.BetaContentBlockParam[] };

export interface CompilerModel {
  send(messages: Anthropic.Beta.BetaMessageParam[]): Promise<ModelReply>;
}

export class ClaudeCompilerModel implements CompilerModel {
  constructor(private client = new Anthropic()) {}

  async send(messages: Anthropic.Beta.BetaMessageParam[]): Promise<ModelReply> {
    // Streamed: compiling can take a while and produce long output.
    const stream = this.client.beta.messages.stream({
      model: COMPILER_MODEL,
      max_tokens: 64_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(CompiledWorkflow) },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      messages,
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      throw new CompileError(`Claude declined to compile this recording${category ? ` (${category})` : ""}`);
    }
    if (message.stop_reason === "max_tokens") throw new CompileError("Claude's answer was cut off before it finished");
    // parsed_output is added by the SDK; echo the blocks back as the API sent them so thinking stays valid.
    const content = message.content.map((block) => {
      if (block.type !== "text") return block;
      const { parsed_output: _parsed, ...rest } = block as typeof block & { parsed_output?: unknown };
      return rest;
    }) as Anthropic.Beta.BetaContentBlockParam[];
    return { parsed: message.parsed_output, content };
  }
}

export type PreviewList = { name: string; count: number; sample: ListItem[] };
export type PreviewResult = { lists: PreviewList[]; error?: string };

export type CompileResult = {
  workflow: Workflow;
  compiled: CompiledWorkflow;
  preview?: PreviewResult;
  /** Problems left after the last correction round; empty when the workflow is ready. */
  problems: string[];
  rounds: number;
};

/** Problems the live-page check found: setup failing, or lists that came back empty. */
export function previewProblems(workflow: Workflow, preview: PreviewResult): string[] {
  if (preview.error) return [`running the setup steps on the live page failed: ${preview.error}`];
  const problems: string[] = [];
  for (const step of workflow.steps) {
    if (step.kind !== "extractList") continue;
    const list = preview.lists.find((l) => l.name === step.name);
    if (!list || list.count === 0) {
      problems.push(`extractList "${step.name}" found no items on the live page with itemSelector "${step.itemSelector}"`);
      continue;
    }
    for (const field of Object.keys(step.fields)) {
      if (list.sample.every((item) => !item[field])) {
        problems.push(`extractList "${step.name}": field "${field}" was empty in every item checked (${JSON.stringify(step.fields[field])})`);
      }
    }
  }
  return problems;
}

export async function compile(
  recording: Recording,
  instruction: string,
  deps: {
    model: CompilerModel;
    loadScreenshot: ScreenshotLoader;
    /** Runs the workflow's setup on the live page; omitted when the browser isn't available. */
    preview?: (workflow: Workflow) => Promise<PreviewResult>;
    id?: string;
  },
): Promise<CompileResult> {
  const steps = mergeEvents(recording.events, recording.overrides);
  if (steps.length === 0) throw new CompileError("the recording has no steps");
  const meta = { id: deps.id ?? randomUUID(), recordingId: recording.id, instruction };
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: buildContext(instruction, steps, recording.events, deps.loadScreenshot) },
  ];

  for (let round = 1; ; round++) {
    const reply = await deps.model.send(messages);
    if (!reply.parsed) throw new CompileError("Claude's answer didn't match the expected format");
    const { workflow, errors } = toWorkflow(reply.parsed, { steps, recorded: recording.events }, meta);
    let problems = errors;
    let preview: PreviewResult | undefined;
    if (problems.length === 0 && deps.preview) {
      preview = await deps.preview(workflow);
      problems = previewProblems(workflow, preview);
    }
    if (problems.length === 0 || round > MAX_REPAIRS) {
      return { workflow, compiled: reply.parsed, preview, problems, rounds: round };
    }
    messages.push({ role: "assistant", content: reply.content }, { role: "user", content: repairMessage(problems) });
  }
}
