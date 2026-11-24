import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { type ListItem, type Recording, type Workflow, mergeEvents } from "@d2a/shared";
import { toWorkflow } from "./convert.js";
import { SYSTEM_PROMPT, type ScreenshotLoader, buildContext, feedbackMessage, repairMessage } from "./prompt.js";
import * as z from "zod/v4";
import { CompiledWorkflow } from "./schema.js";

export const COMPILER_MODEL = "claude-opus-5-5";
/** Correction rounds after the first answer, for conversion or live-page problems. */
const MAX_REPAIRS = 2;
/** List items returned by the live-page check, for the problems check and the review UI. */
export const SAMPLE_ITEMS = 3;

export class CompileError extends Error {}

/** The answer's text, plus the content blocks exactly as returned (to send back on a correction round). */
export type ModelReply = { text: string; content: Anthropic.Beta.BetaContentBlockParam[] };

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
      output_config: { effort: "high" },
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
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    // Echoed back unchanged on a correction round, so thinking blocks stay valid.
    return { text, content: message.content as Anthropic.Beta.BetaContentBlockParam[] };
  }
}

export type PreviewList = { name: string; count: number; sample: ListItem[] };
export type PreviewResult = { lists: PreviewList[]; error?: string };

/** Parses Claude's JSON answer; on failure returns problems to send back. */
export function parseAnswer(text: string): { answer: CompiledWorkflow } | { problems: string[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return { problems: ["the answer did not contain a JSON object"] };
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { problems: [`the answer was not valid JSON: ${(err as Error).message}`] };
  }
  const parsed = CompiledWorkflow.safeParse(json);
  if (!parsed.success) return { problems: [`the answer did not match the schema:\n${z.prettifyError(parsed.error)}`] };
  return { answer: parsed.data };
}

export type CompileResult = {
  workflow: Workflow;
  compiled: CompiledWorkflow;
  preview?: PreviewResult;
  /** Problems left after the last correction round; empty when the workflow is ready. */
  problems: string[];
  rounds: number;
  /** Problems sent back to Claude in each correction round, oldest first. */
  corrections: string[][];
  /** The whole conversation, ending with Claude's final answer; saved so the user can follow up. */
  messages: Anthropic.Beta.BetaMessageParam[];
};

type Deps = {
  model: CompilerModel;
  loadScreenshot: ScreenshotLoader;
  /** Runs the workflow's setup on the live page; omitted when the browser isn't available. */
  preview?: (workflow: Workflow) => Promise<PreviewResult>;
  id?: string;
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

export async function compile(recording: Recording, instruction: string, deps: Deps): Promise<CompileResult> {
  const steps = mergeEvents(recording.events, recording.overrides);
  if (steps.length === 0) throw new CompileError("the recording has no steps");
  const meta = { id: deps.id ?? randomUUID(), recordingId: recording.id, instruction };
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: buildContext(instruction, steps, recording.events, deps.loadScreenshot) },
  ];
  return converge(messages, recording, meta, deps);
}

/**
 * Continues a saved compile conversation with the user's answers and/or requested changes.
 * Append-only: earlier turns are sent back unchanged so Claude's thinking stays valid.
 */
export async function refine(
  recording: Recording,
  workflow: Workflow,
  history: Anthropic.Beta.BetaMessageParam[],
  feedback: { answers: { question: string; answer: string }[]; request?: string },
  deps: Deps,
): Promise<CompileResult> {
  if (!feedback.answers.length && !feedback.request) throw new CompileError("nothing to change: give an answer or a request");
  const messages = [...history, { role: "user" as const, content: feedbackMessage(feedback.answers, feedback.request) }];
  const meta = { id: workflow.id, recordingId: recording.id, instruction: workflow.instruction ?? "" };
  return converge(messages, recording, meta, deps);
}

/** Asks Claude, validates and checks the answer, and sends problems back until it's usable. */
async function converge(
  messages: Anthropic.Beta.BetaMessageParam[],
  recording: Recording,
  meta: { id: string; recordingId: string; instruction: string },
  deps: Deps,
): Promise<CompileResult> {
  // Merged the same way as when the conversation started, so step ids still match.
  const steps = mergeEvents(recording.events, recording.overrides);
  const corrections: string[][] = [];
  for (let round = 1; ; round++) {
    const reply = await deps.model.send(messages);
    const parsed = parseAnswer(reply.text);
    let problems: string[];
    let result: CompileResult | undefined;
    if ("problems" in parsed) {
      problems = parsed.problems;
    } else {
      const { workflow, errors } = toWorkflow(parsed.answer, { steps, recorded: recording.events }, meta);
      problems = errors;
      let preview: PreviewResult | undefined;
      if (problems.length === 0 && deps.preview) {
        preview = await deps.preview(workflow);
        problems = previewProblems(workflow, preview);
      }
      result = { workflow, compiled: parsed.answer, preview, problems, rounds: round, corrections, messages };
    }
    if (result && (problems.length === 0 || round > MAX_REPAIRS)) {
      messages.push({ role: "assistant", content: reply.content });
      return result;
    }
    if (round > MAX_REPAIRS) throw new CompileError(`Claude's answer could not be read: ${problems.join("; ")}`);
    corrections.push(problems);
    messages.push({ role: "assistant", content: reply.content }, { role: "user", content: repairMessage(problems) });
  }
}
