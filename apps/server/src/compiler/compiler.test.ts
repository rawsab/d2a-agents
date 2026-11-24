import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { type RawEvent, type RecordedEvent, type Recording, mergeEvents } from "@d2a/shared";
import { type CompilerModel, type ModelReply, type PreviewResult, compile, refine } from "./index.js";
import { toWorkflow } from "./convert.js";
import { buildContext } from "./prompt.js";
import type { CompiledWorkflow, InnerStep, TargetRef, TopStep } from "./schema.js";

const LIST = "http://127.0.0.1:7822/list.html";
const FORM = "http://127.0.0.1:7822/form.html";
const share2 = { role: "button", name: "Share", css: "#playlist > li:nth-of-type(2) > button", xpath: "/html/body/ul/li[2]/button" };
const copyBtn = { role: "button", name: "Copy", css: "#copy", xpath: "/html/body/dialog/button[1]" };
const field = { role: "textbox", name: "Paste link", css: "#url", xpath: "/html/body/form/input" };
const download = { role: "button", name: "Download", css: "#dl > button", xpath: "/html/body/form/button" };
const inventory = [1, 2, 3, 4].map((i) => ({
  tag: "a",
  fingerprint: { role: "link", name: `Video ${i}`, href: `http://127.0.0.1:7822/watch?v=vid${i}`, css: `#playlist > li:nth-of-type(${i}) > a` },
}));

const ev = (event: RawEvent, extra: Partial<RecordedEvent> = {}): RecordedEvent => ({ event, ...extra });
/** The fixture demonstration, plus an accidental click on the heading. */
const recording: Recording = {
  id: "rec1",
  name: "demo",
  createdAt: 0,
  events: [
    ev({ type: "tabActivated", tabId: 1, url: LIST, ts: 0 }),
    ev({ id: "h", type: "click", tabId: 1, url: LIST, ts: 100, target: { role: "heading", name: "Playlist", xpath: "/html/body/h1" } }),
    ev({ type: "effect", tabId: 1, url: LIST, ts: 850, actionId: "h", effect: quiet() }),
    ev({ id: "a", type: "click", tabId: 1, url: LIST, ts: 1000, target: share2 }, { inventory, screenshotId: "shot1" }),
    ev({ type: "effect", tabId: 1, url: LIST, ts: 1750, actionId: "a", effect: { ...quiet(), opened: ['dialog "Share this video"'] } }),
    ev({ id: "b", type: "click", tabId: 1, url: LIST, ts: 2000, target: copyBtn }),
    ev({ type: "copy", tabId: 1, url: LIST, ts: 2001, value: "http://127.0.0.1:7822/share/vid2" }),
    ev({ type: "tabActivated", tabId: 2, url: FORM, ts: 3000 }),
    ev({ type: "paste", tabId: 2, url: FORM, ts: 3100, target: field, value: "http://127.0.0.1:7822/share/vid2" }),
    ev({ type: "input", tabId: 2, url: FORM, ts: 3200, target: field, value: "http://127.0.0.1:7822/share/vid2", masked: false }),
    ev({ id: "c", type: "click", tabId: 2, url: FORM, ts: 4000, target: download }),
    ev({ type: "effect", tabId: 2, url: FORM, ts: 4750, actionId: "c", effect: { ...quiet(), mutations: 1, requests: 1, appeared: ["Queued http://127.0.0.1:7822/share/vid2"] } }),
  ],
};

function quiet() {
  return {
    windowMs: 750, mutations: 0, baselineMutations: 0, requests: 0, baselineRequests: 0, urlChanged: false,
    focusMoved: false, expandedChanged: false, opened: [], closed: [], copied: false, unloaded: false,
  };
}

const ref = (r: Partial<TargetRef> & { description: string }): TargetRef => ({
  fromStep: null, inventoryIndex: null, role: null, name: null, css: null, withinItem: false, ...r,
});
const blank: Omit<InnerStep, "id" | "kind"> = {
  basedOn: [], tab: null, url: null, target: null, until: null, value: null, key: null, textIncludes: null, urlMatches: null,
  timeoutMs: null, name: null, attr: null, container: null, itemSelector: null, fields: null, condition: null,
};
const inner = (s: Partial<InnerStep> & Pick<InnerStep, "id" | "kind">): InnerStep => ({ ...blank, ...s });
const top = (s: Partial<TopStep> & Pick<TopStep, "id" | "kind">): TopStep => ({ ...blank, list: null, as: null, body: null, ...s });

/** What a good answer looks like for "repeat for every video". Step ids refer to mergeEvents' output. */
function goodAnswer(): CompiledWorkflow {
  return {
    name: "Playlist → downloader",
    summary: "Copies each video's share link and submits it to the downloader.",
    tabs: [{ role: "playlist", startUrl: LIST }, { role: "downloader", startUrl: FORM }],
    closePopups: false,
    steps: [
      top({ id: "w1", kind: "switchTab", tab: "playlist" }),
      top({
        id: "w2", kind: "extractList", name: "videos", itemSelector: "#playlist > li",
        fields: [{ name: "title", selector: "a", attr: null }, { name: "url", selector: "a", attr: "href" }],
      }),
      top({
        id: "w3", kind: "forEach", list: "videos", as: "video",
        body: [
          inner({ id: "w3.1", kind: "switchTab", tab: "playlist" }),
          inner({
            id: "w3.2", kind: "click", basedOn: ["s3"],
            target: ref({ description: "this video's Share button", fromStep: "s3", css: "button", withinItem: true }),
            until: { target: ref({ description: "Copy button", fromStep: "s4" }), textIncludes: null, urlMatches: null },
          }),
          inner({ id: "w3.3", kind: "click", basedOn: ["s4"], target: ref({ description: "Copy button", fromStep: "s4" }) }),
          inner({ id: "w3.4", kind: "copyFromClipboard", name: "link" }),
          inner({ id: "w3.5", kind: "switchTab", tab: "downloader" }),
          inner({ id: "w3.6", kind: "fill", target: ref({ description: "link field", fromStep: "s6" }), value: "{{link}}" }),
          inner({ id: "w3.7", kind: "click", target: ref({ description: "Download", fromStep: "s7" }) }),
        ],
      }),
    ],
    excludedSteps: [{ step: "s2", reason: "accidental click on the heading" }],
    assumptions: [],
    questions: [],
  };
}

const steps = mergeEvents(recording.events);
const meta = { id: "wf1", recordingId: "rec1", instruction: "repeat for every video" };

describe("merged fixture recording", () => {
  it("has the step ids the tests refer to", () => {
    expect(steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["s1:switchTab", "s2:click", "s3:click", "s4:copy", "s5:switchTab", "s6:fill", "s7:click"]);
    expect(steps[1].noise?.rule).toBe("no-effect");
  });
});

describe("toWorkflow", () => {
  it("resolves recorded targets, refining them, and scopes per-item targets to the loop item", () => {
    const { workflow, errors } = toWorkflow(goodAnswer(), { steps, recorded: recording.events }, meta);
    expect(errors).toEqual([]);
    const loop = workflow.steps[2];
    if (loop.kind !== "forEach") throw new Error("expected forEach");
    const shareClick = loop.body[1];
    if (shareClick.kind !== "click") throw new Error("expected click");
    // Recorded role/name kept; the item-specific CSS replaced; scoped to the current video.
    expect(shareClick.target).toMatchObject({ within: "video", fingerprint: { role: "button", name: "Share", css: "button" } });
    expect(shareClick.until?.target?.fingerprint).toMatchObject(copyBtn);
    expect(workflow.tabs).toEqual({ playlist: { startUrl: LIST }, downloader: { startUrl: FORM } });
  });

  it("adds a retry condition to clicks that opened something, waiting for the next step's element", () => {
    const answer = goodAnswer();
    delete (answer.steps[2].body![1] as Partial<InnerStep>).until;
    const { workflow, errors } = toWorkflow(answer, { steps, recorded: recording.events }, meta);
    expect(errors).toEqual([]);
    const loop = workflow.steps[2];
    if (loop.kind !== "forEach") throw new Error("expected forEach");
    const [, share, copy] = loop.body;
    // s3 (Share) opened a dialog in the recording; Copy is the next element acted on.
    expect(share).toMatchObject({ kind: "click", until: { target: { description: "Copy button" } } });
    expect(copy).not.toHaveProperty("until"); // the Copy click opened nothing
  });

  it("converts tab steps and checks that opensTab names a declared tab", () => {
    const answer = goodAnswer();
    answer.tabs.push({ role: "result", startUrl: null });
    answer.steps.push(
      top({ id: "w4", kind: "click", target: ref({ description: "Download", fromStep: "s7" }), opensTab: "result" }),
      top({ id: "w5", kind: "closeTab", tab: "result" }),
      top({ id: "w6", kind: "openTab", tab: "downloader", url: FORM }),
    );
    const ok = toWorkflow(answer, { steps, recorded: recording.events }, meta);
    expect(ok.errors).toEqual([]);
    expect(ok.workflow.tabs.result).toEqual({});
    expect(ok.workflow.steps.slice(3)).toMatchObject([
      { kind: "click", opensTab: "result" },
      { kind: "closeTab", role: "result" },
      { kind: "openTab", role: "downloader", url: FORM },
    ]);

    answer.steps[3].opensTab = "nowhere";
    expect(toWorkflow(answer, { steps, recorded: recording.events }, meta).errors).toEqual([
      'step w4 (click): opensTab "nowhere" is not declared in tabs',
    ]);
  });

  it("waits for text anywhere on the page when waitFor has only textIncludes", () => {
    const answer = goodAnswer();
    answer.steps[2].body!.push(inner({ id: "w3.8", kind: "waitFor", textIncludes: "Queued {{link}}" }));
    const { workflow, errors } = toWorkflow(answer, { steps, recorded: recording.events }, meta);
    expect(errors).toEqual([]);
    const loop = workflow.steps[2];
    expect(loop.kind === "forEach" && loop.body.at(-1)).toMatchObject({
      kind: "waitFor",
      textIncludes: "Queued {{link}}",
      target: { fingerprint: { css: "body" } },
    });
  });

  it("picks elements from a step's page inventory", () => {
    const answer = goodAnswer();
    answer.steps.splice(2, 1, top({ id: "w3", kind: "click", target: ref({ description: "Video 4", fromStep: "s3", inventoryIndex: 3 }) }));
    const { workflow, errors } = toWorkflow(answer, { steps, recorded: recording.events }, meta);
    expect(errors).toEqual([]);
    expect(workflow.steps[2]).toMatchObject({ kind: "click", target: { fingerprint: { href: "http://127.0.0.1:7822/watch?v=vid4" } } });
  });

  it("reports every problem at once", () => {
    const answer = goodAnswer();
    const loop = answer.steps[2];
    loop.body![1].target = ref({ description: "ghost", fromStep: "s99" });
    loop.body![5].value = "{{video.thumbnail}} {{nope}}";
    answer.steps.push(top({ id: "w4", kind: "click", target: ref({ description: "stray", fromStep: "s3", withinItem: true }) }));
    answer.steps.push(top({ id: "w5", kind: "navigate", tab: "elsewhere", url: "https://x.example" }));
    const { errors } = toWorkflow(answer, { steps, recorded: recording.events }, meta);
    expect(errors).toEqual([
      'step w3.2 (click): fromStep "s99" is not a recorded step',
      'step w3.6 (fill): {{video.thumbnail}}: "video" items have fields title, url, _index, _selector',
      "step w3.6 (fill): {{nope}} refers to an undefined variable",
      'step w4 (click): target "stray" has withinItem but is not inside a forEach',
      'step w5 (navigate): tab "elsewhere" is not declared in tabs',
    ]);
  });
});

describe("buildContext", () => {
  it("includes the instruction, steps with noise and effects, one inventory per page, and screenshots", () => {
    const blocks = buildContext("repeat for every video", steps, recording.events, (id) =>
      id === "shot1" ? { mime: "image/jpeg", data: new Uint8Array([1, 2, 3]) } : undefined,
    );
    const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    expect(text).toContain("<instruction>\nrepeat for every video\n</instruction>");
    expect(text).toContain("[s2] Click heading \"Playlist\"");
    expect(text).toContain("likely noise (85%)");
    expect(text).toContain('effect: opened dialog "Share this video"');
    expect(text).toContain('copied: "http://127.0.0.1:7822/share/vid2"');
    expect(text).toContain('showed "Queued http://127.0.0.1:7822/share/vid2"');
    expect(text).toContain('3: link "Video 4" href=http://127.0.0.1:7822/watch?v=vid4 css=#playlist > li:nth-of-type(4) > a');
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });
});

/** Replays scripted answers and records what it was sent. */
class FakeModel implements CompilerModel {
  calls: Anthropic.Beta.BetaMessageParam[][] = [];
  constructor(private answers: (CompiledWorkflow | string)[]) {}
  async send(messages: Anthropic.Beta.BetaMessageParam[]): Promise<ModelReply> {
    this.calls.push(structuredClone(messages));
    const parsed = this.answers[this.calls.length - 1];
    const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    return { text, content: [{ type: "thinking", thinking: "", signature: `sig${this.calls.length}` }, { type: "text", text }] };
  }
}

describe("compile", () => {
  const loadScreenshot = () => undefined;

  it("sends conversion problems back and accepts the corrected answer", async () => {
    const bad = goodAnswer();
    bad.steps[2].body![2].target = ref({ description: "Copy", fromStep: "s99" });
    const model = new FakeModel([bad, goodAnswer()]);
    const result = await compile(recording, "repeat for every video", { model, loadScreenshot });
    expect(result.rounds).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.corrections).toEqual([['step w3.3 (click): fromStep "s99" is not a recorded step']]);
    const second = model.calls[1];
    expect(second).toHaveLength(3);
    // The first answer goes back exactly as returned (thinking blocks included), then the problems.
    expect(second[1]).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig1" }, { type: "text", text: JSON.stringify(bad) }] });
    expect(second[2].content).toContain('fromStep "s99" is not a recorded step');
  });

  it("checks lists on the live page and asks for a fix when a selector finds nothing", async () => {
    const bad = goodAnswer();
    bad.steps[1].itemSelector = ".playlist-item";
    const previews: PreviewResult[] = [
      { lists: [{ name: "videos", count: 0, sample: [] }] },
      { lists: [{ name: "videos", count: 4, sample: [{ _index: 0, _selector: "#playlist > li:nth-of-type(1)", title: "Video One", url: "x" }] }] },
    ];
    const model = new FakeModel([bad, goodAnswer()]);
    const result = await compile(recording, "repeat", { model, loadScreenshot, preview: async () => previews.shift()! });
    expect(model.calls[1][2].content).toContain('extractList "videos" found no items on the live page with itemSelector ".playlist-item"');
    expect(result.preview?.lists[0].count).toBe(4);
    expect(result.problems).toEqual([]);
  });

  it("asks again when the answer isn't valid JSON for the schema", async () => {
    const model = new FakeModel([`Here you go: {"name": "x"}`, goodAnswer()]);
    const result = await compile(recording, "repeat", { model, loadScreenshot });
    expect(result.rounds).toBe(2);
    expect(model.calls[1][2].content).toContain("the answer did not match the schema");
    expect(model.calls[1][2].content).toContain("summary");
  });

  it("continues the saved conversation with the user's answers, appending only", async () => {
    const first = goodAnswer();
    first.questions = ["Should ad tabs be closed?"];
    const second = { ...goodAnswer(), closePopups: true };
    const model = new FakeModel([first, second]);
    const compiled = await compile(recording, "repeat", { model, loadScreenshot });
    expect(compiled.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const refined = await refine(
      recording,
      compiled.workflow,
      compiled.messages,
      { answers: [{ question: "Should ad tabs be closed?", answer: "Yes, close them" }], request: "Also skip Video Two" },
      { model, loadScreenshot },
    );
    const sent = model.calls[1];
    expect(sent.slice(0, 2)).toEqual(compiled.messages); // history unchanged, thinking block included
    expect(sent[2].content).toBe(
      "The user answered your questions:\nQ: Should ad tabs be closed?\nA: Yes, close them\n\nThe user asks for these changes:\nAlso skip Video Two\n\nReturn the complete updated automation.",
    );
    expect(refined.workflow).toMatchObject({ id: compiled.workflow.id, closePopups: true, instruction: "repeat" });
    expect(refined.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("gives up after two correction rounds and returns the remaining problems", async () => {
    const bad = goodAnswer();
    bad.tabs[0].startUrl = "list.html";
    const result = await compile(recording, "repeat", { model: new FakeModel([bad, bad, bad]), loadScreenshot });
    expect(result.rounds).toBe(3);
    expect(result.problems).toEqual(['tab "playlist": startUrl must be an absolute http(s) URL']);
  });
});
