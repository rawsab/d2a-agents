import {
  type Fingerprint,
  type PageInventory,
  type RecordedEvent,
  type Recording,
  type SemanticStep,
  type Step,
  type Target,
  type Viewport,
  type Workflow,
  type WorkflowProblem,
  checkWorkflow,
  describeStep,
  describeWorkflowStep,
  mergeEvents,
} from "@d2a/shared";
import { API_URL as API } from "../config.js";
import {
  KIND_LABELS,
  type StepDiff,
  type StepKind,
  allSteps,
  appendStep,
  blankStep,
  deleteStep,
  diffSteps,
  insertStep,
  listNames,
  locate,
  moveStep,
  newId,
  pickedTarget,
  renameTab,
  replaceStep,
  templatesAt,
} from "./model.js";

// ---- DOM helpers ----

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | false | null | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | string = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(typeof attrs === "string" ? { class: attrs } : attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") e.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") e.className = String(v);
    else if (k in e && typeof (e as unknown as Record<string, unknown>)[k] !== "object") (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) e.append(c);
  return e;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

// ---- State ----

const workflowId = new URLSearchParams(location.search).get("id") ?? "";
let saved: Workflow;
let current: Workflow;
let selected: string | undefined;
let proposal: { id: string; workflow: Workflow; diff: StepDiff } | undefined;
let recording: Recording | undefined;
let recSteps = new Map<string, SemanticStep>();

const dirty = () => JSON.stringify(current) !== JSON.stringify(saved);
/** The version shown: Claude's proposal while one is open, else the one being edited. */
const shown = () => proposal?.workflow ?? current;

// ---- What the recording saw at a step ----

type View = { stepId: string; screenshotId?: string; inventory?: PageInventory; viewport?: Viewport; step: SemanticStep };

function viewOf(stepId: string | undefined): View | undefined {
  const step = stepId ? recSteps.get(stepId) : undefined;
  if (!step || !recording) return undefined;
  const events = step.events.map((i) => recording!.events[i]).filter((e): e is RecordedEvent => Boolean(e));
  const withInventory = events.find((e) => e.inventory);
  return {
    stepId: step.id,
    step,
    screenshotId: events.find((e) => e.screenshotId)?.screenshotId,
    inventory: withInventory?.inventory,
    viewport: withInventory?.viewport,
  };
}

/** The recorded step a workflow step came from, if any. */
function ownSource(step: Step): string | undefined {
  return ("target" in step && step.target?.source?.step) || step.basedOn?.[0] || undefined;
}

/** Where the element picker starts: the step's own source, else the closest earlier step that has one. */
function sourceOf(step: Step): string | undefined {
  let last: string | undefined;
  for (const s of allSteps(shown().steps)) {
    if (s.id === step.id) return ownSource(s) ?? last;
    last = ownSource(s) ?? last;
  }
  return last;
}

function bboxOf(target: Target): Fingerprint["bbox"] {
  const view = viewOf(target.source?.step);
  if (!view) return undefined;
  if (target.source?.inventoryIndex !== undefined) return view.inventory?.[target.source.inventoryIndex]?.fingerprint.bbox;
  return "target" in view.step ? view.step.target?.bbox : undefined;
}

type Box = {
  bbox: NonNullable<Fingerprint["bbox"]>;
  cls?: string;
  title?: string;
  onClick?: () => void;
  onHover?: (on: boolean) => void;
  /** Called with the box element once it is placed (after the image loads, for older recordings). */
  placed?: (box: HTMLElement) => void;
};

/**
 * Size of the screenshot in the page's CSS pixels. A screenshot covers the visible part of the tab,
 * which can be shorter than the reported viewport, so only the width is used to scale.
 */
function pageSize(img: HTMLImageElement, view: View): { w: number; h: number } {
  // Older recordings didn't store the viewport; screenshots are taken at the screen's pixel ratio.
  const w = view.viewport?.w ?? img.naturalWidth / devicePixelRatio;
  return { w, h: (img.naturalHeight * w) / img.naturalWidth };
}

function onLoaded(img: HTMLImageElement, fn: () => void) {
  if (img.complete && img.naturalWidth) fn();
  else img.addEventListener("load", fn, { once: true });
}

/** A recorded screenshot with element boxes drawn on it, positioned in % so it scales with the image. */
function screenshot(view: View, boxes: Box[]): HTMLElement {
  const wrap = h("div", "shot");
  const img = h("img", { src: `${API}/screenshots/${view.screenshotId}`, alt: "" });
  wrap.append(img);
  onLoaded(img, () => {
    const { w, h: ph } = pageSize(img, view);
    for (const b of boxes) {
      if (b.bbox.y >= ph || b.bbox.x >= w) continue; // outside what the screenshot shows
      const box = h("div", { class: `box ${b.cls ?? ""}`, title: b.title, onclick: b.onClick, onmouseenter: () => b.onHover?.(true), onmouseleave: () => b.onHover?.(false) });
      Object.assign(box.style, {
        left: `${(b.bbox.x / w) * 100}%`, top: `${(b.bbox.y / ph) * 100}%`,
        width: `${(b.bbox.w / w) * 100}%`, height: `${(b.bbox.h / ph) * 100}%`,
      });
      wrap.append(box);
      b.placed?.(box);
    }
  });
  return wrap;
}

const THUMB = { w: 96, h: 56 };

/** A small crop of a screenshot around an element (or the top of the page), so a card shows what it acts on. */
function thumbnail(view: View, bbox: Fingerprint["bbox"]): HTMLElement {
  const frame = h("div", "thumb");
  const img = h("img", { src: `${API}/screenshots/${view.screenshotId}`, alt: "" });
  frame.append(img);
  onLoaded(img, () => {
    const page = pageSize(img, view);
    // Show the element with some of what surrounds it.
    const rw = Math.min(page.w, Math.max(320, (bbox?.w ?? 0) * 4));
    const rh = (rw * THUMB.h) / THUMB.w;
    const cx = bbox ? bbox.x + bbox.w / 2 : rw / 2;
    const cy = bbox ? bbox.y + bbox.h / 2 : rh / 2;
    const rx = Math.max(0, Math.min(cx - rw / 2, page.w - rw));
    const ry = Math.max(0, Math.min(cy - rh / 2, page.h - rh));
    const scale = THUMB.w / rw;
    Object.assign(img.style, { width: `${page.w * scale}px`, left: `${-rx * scale}px`, top: `${-ry * scale}px` });
    if (bbox) {
      const box = h("div", "box");
      Object.assign(box.style, { left: `${(bbox.x - rx) * scale}px`, top: `${(bbox.y - ry) * scale}px`, width: `${bbox.w * scale}px`, height: `${bbox.h * scale}px` });
      frame.append(box);
    }
  });
  return frame;
}

// ---- Rendering ----

function render() {
  renderBar();
  renderProposal();
  renderProblems();
  renderSettings();
  renderTimeline();
  renderInspector();
}

/** After a field edit: everything but the inspector, so the input being typed in keeps focus. */
function refresh() {
  renderBar();
  renderProblems();
  renderTimeline();
}

function setWorkflow(next: Workflow, full = false) {
  current = next;
  if (full) render();
  else refresh();
}

function renderBar() {
  const name = $<HTMLInputElement>("name");
  if (document.activeElement !== name) name.value = shown().name;
  name.disabled = Boolean(proposal);
  const problems = checkWorkflow(current).length;
  const state = $("state");
  state.textContent = dirty() ? "Unsaved changes" : "Saved";
  if (problems) state.textContent += ` · ${problems} problem${problems > 1 ? "s" : ""}`;
  state.classList.toggle("dirty", dirty());
  $<HTMLButtonElement>("save").disabled = !dirty() || Boolean(proposal);
  $("revert").hidden = !dirty() || Boolean(proposal);
  $("ask").hidden = Boolean(proposal);
  for (const id of ["dry", "run"]) $<HTMLButtonElement>(id).disabled = Boolean(proposal);
}

function renderProposal() {
  $("proposal").hidden = !proposal;
  if (!proposal) return;
  const notes = proposal.workflow.notes;
  $("proposal-summary").textContent = notes?.summary ?? "";
  const list = $("proposal-notes");
  list.replaceChildren(
    ...(notes?.problems ?? []).map((p) => h("li", "problem", `Problem: ${p}`)),
    ...(notes?.assumptions ?? []).map((a) => h("li", {}, `Assumed: ${a}`)),
    ...(notes?.questions ?? []).map((q) => h("li", {}, `Question: ${q}`)),
  );
}

function problemsByStep(): Map<string, WorkflowProblem[]> {
  const map = new Map<string, WorkflowProblem[]>();
  for (const p of checkWorkflow(shown())) if (p.stepId) map.set(p.stepId, [...(map.get(p.stepId) ?? []), p]);
  return map;
}

function renderProblems() {
  const list = $("problems");
  list.replaceChildren(
    ...checkWorkflow(shown()).map((p) =>
      h("li", { onclick: () => p.stepId && select(p.stepId) }, p.stepId ? `${stepLabel(p.stepId)}: ${p.message}` : p.message),
    ),
  );
}

function stepLabel(id: string): string {
  const i = allSteps(shown().steps).findIndex((s) => s.id === id);
  return i === -1 ? id : `Step ${i + 1}`;
}

function renderSettings() {
  const body = $("settings-body");
  const wf = shown();
  const locked = Boolean(proposal);
  const tabs = h("div", "tabs");
  for (const [role, tab] of Object.entries(wf.tabs)) {
    const roleInput = h("input", { value: role, disabled: locked, "aria-label": "Tab name" });
    roleInput.onchange = () => {
      const to = roleInput.value.trim();
      if (!to || to === role || to in current.tabs) return void (roleInput.value = role);
      setWorkflow(renameTab(current, role, to), true);
    };
    const url = h("input", { value: tab.startUrl ?? "", placeholder: "Opened by a step (no start URL)", disabled: locked, "aria-label": `${role} start URL` });
    url.oninput = () => setWorkflow({ ...current, tabs: { ...current.tabs, [role]: url.value.trim() ? { startUrl: url.value.trim() } : {} } });
    const remove = h("button", { class: "ghost small danger", disabled: locked || Object.keys(wf.tabs).length < 2, title: "Remove tab" }, "✕");
    remove.onclick = () => {
      const { [role]: _, ...rest } = current.tabs;
      setWorkflow({ ...current, tabs: rest }, true);
    };
    tabs.append(roleInput, url, remove);
  }
  const add = h("button", { class: "small", disabled: locked }, "Add tab");
  add.onclick = () => {
    let n = Object.keys(current.tabs).length + 1;
    while (`tab${n}` in current.tabs) n++;
    setWorkflow({ ...current, tabs: { ...current.tabs, [`tab${n}`]: {} } }, true);
  };
  const popups = h("input", { type: "checkbox", checked: Boolean(wf.closePopups), disabled: locked, id: "close-popups" });
  popups.onchange = () => {
    const { closePopups: _, ...rest } = current;
    setWorkflow(popups.checked ? { ...rest, closePopups: true } : rest);
  };
  body.replaceChildren(
    tabs,
    h("div", "row", add),
    h("p", "row", popups, h("label", { htmlFor: "close-popups" }, "Close tabs that pages open on other sites (ads) while it runs")),
  );
}

function renderTimeline() {
  const wf = shown();
  const list = $<HTMLOListElement>("steps");
  const problems = problemsByStep();
  let n = 0;
  const cards = (steps: Step[], loop?: string): HTMLElement[] =>
    steps.map((step) => {
      n++;
      const card = stepCard(step, n, problems.get(step.id));
      if (step.kind !== "forEach") return h("li", {}, card);
      const body = h("ol", {}, ...cards(step.body, step.id));
      if (!proposal) body.append(h("li", {}, addMenu("Add a step to the loop", (kind) => add(kind, { loop: step.id }), true)));
      return h("li", "loop", card, body);
    });
  list.replaceChildren(...cards(wf.steps));
  if (!proposal) list.append(h("li", {}, addMenu("Add a step", (kind) => add(kind, {}))));
  if (proposal?.diff.removed.length) {
    list.append(
      h("li", "removed-title", "Removed"),
      ...proposal.diff.removed.map((step) => h("li", {}, stepCard(step, undefined, undefined, "removed"))),
    );
  }
}

function stepCard(step: Step, n: number | undefined, problems?: WorkflowProblem[], forced?: "removed"): HTMLElement {
  const status = forced ?? proposal?.diff.status.get(step.id);
  const view = viewOf(ownSource(step));
  const card = h("div", { class: `card ${status && status !== "unchanged" ? status : ""} ${selected === step.id ? "selected" : ""}`, "data-step": step.id });
  card.onclick = () => select(step.id);
  const before = status === "changed" ? proposal?.diff.before.get(step.id) : undefined;
  const wasText = before && describeWorkflowStep(before) !== describeWorkflowStep(step) ? describeWorkflowStep(before) : undefined;
  const main = h(
    "div",
    {},
    h("div", "kind", KIND_LABELS[step.kind], status && status !== "unchanged" && h("span", "badge", status)),
    h("div", "desc", describeWorkflowStep(step)),
    wasText && h("div", "was", wasText),
    ...(problems ?? []).map((p) => h("div", "warn", `⚠ ${p.message}`)),
  );
  const side = h("div", "side");
  if (!proposal && !forced) {
    const move = (dir: -1 | 1) => (e: Event) => {
      e.stopPropagation();
      setWorkflow(moveStep(current, step.id, dir), true);
    };
    const remove = (e: Event) => {
      e.stopPropagation();
      if (step.kind === "forEach" && step.body.length && !confirm(`Delete the loop and its ${step.body.length} steps?`)) return;
      if (selected === step.id) selected = undefined;
      setWorkflow(deleteStep(current, step.id), true);
    };
    side.append(
      h("div", "moves",
        h("button", { class: "ghost small", title: "Move up", "aria-label": "Move up", onclick: move(-1) }, "↑"),
        h("button", { class: "ghost small", title: "Move down", "aria-label": "Move down", onclick: move(1) }, "↓"),
        h("button", { class: "ghost small danger", title: "Delete", "aria-label": "Delete", onclick: remove }, "✕"),
      ),
    );
  }
  const target = "target" in step ? step.target : undefined;
  if (view?.screenshotId) side.append(thumbnail(view, target && target.source?.step === view.stepId ? bboxOf(target) : undefined));
  card.append(h("div", "num", n === undefined ? "" : String(n)), main, side);
  return card;
}

function addMenu(label: string, onPick: (kind: StepKind) => void, inLoop = false): HTMLElement {
  const sel = h("select", { "aria-label": label }, h("option", { value: "" }, `+ ${label}…`));
  for (const [kind, text] of Object.entries(KIND_LABELS)) {
    if (inLoop && kind === "forEach") continue;
    sel.append(h("option", { value: kind }, text));
  }
  sel.onchange = () => {
    const kind = sel.value as StepKind;
    sel.value = "";
    if (kind) onPick(kind);
  };
  return h("div", "add", sel);
}

function add(kind: StepKind, where: { after?: string; loop?: string }) {
  const step = blankStep(kind, newId(current), current);
  current = where.after ? insertStep(current, step, where.after) : appendStep(current, step, where.loop);
  selected = step.id;
  render();
  // A new step on an element starts by choosing the element.
  if ("target" in step && step.target) openPicker(step, step.target, (t) => updateStep({ ...step, target: t } as Step, true));
}

function select(id: string) {
  selected = id;
  renderTimeline();
  renderInspector();
  document.querySelector(`[data-step="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
}

function updateStep(step: Step, full = false) {
  current = replaceStep(current, step);
  if (full) render();
  else refresh();
}

// ---- Inspector ----

function renderInspector() {
  const pane = $("inspector");
  const loc = selected ? locate(shown().steps, selected) : undefined;
  if (!loc) return pane.replaceChildren(...recordingPanel());
  const step = loc.container[loc.index];
  const locked = Boolean(proposal);
  const back = h("button", { class: "ghost small", onclick: () => ((selected = undefined), renderTimeline(), renderInspector()) }, "← Recording");
  const header = h("div", {}, h("div", "row", back), h("h2", {}, KIND_LABELS[step.kind]), h("p", "hint", `${stepLabel(step.id)} · id ${step.id}`));
  if (locked) {
    const before = proposal!.diff.before.get(step.id);
    return pane.replaceChildren(
      header,
      h("h3", {}, "After"), h("p", {}, describeWorkflowStep(step)),
      h("h3", {}, "Before"), h("p", {}, before ? describeWorkflowStep(before) : "(new step)"),
    );
  }
  pane.replaceChildren(header, ...stepFields(step, loc.loop?.as), stepActions(step, Boolean(loc.loop)));
}

/** A labelled input bound to one field of the step. */
function textField(label: string, value: string | number | undefined, onChange: (v: string) => void, opts: { placeholder?: string; type?: string; multiline?: boolean } = {}) {
  const id = `f-${label.replace(/\W+/g, "-")}`;
  const input = opts.multiline
    ? h("textarea", { id, rows: 2, placeholder: opts.placeholder ?? "" })
    : h("input", { id, type: opts.type ?? "text", placeholder: opts.placeholder ?? "" });
  input.value = value === undefined ? "" : String(value);
  input.oninput = () => onChange(input.value);
  return [h("label", { htmlFor: id }, label), input];
}

function selectField(label: string, value: string, options: [string, string][], onChange: (v: string) => void) {
  const id = `f-${label.replace(/\W+/g, "-")}`;
  const sel = h("select", { id }, ...options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
  sel.onchange = () => onChange(sel.value);
  return [h("label", { htmlFor: id }, label), sel];
}

/** Sets or clears an optional field. */
function withField<S extends Step>(step: S, key: string, value: unknown): S {
  const next = { ...step } as Record<string, unknown>;
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next as S;
}

function stepFields(step: Step, item: string | undefined): HTMLElement[] {
  const tabOptions = Object.keys(current.tabs).map((r) => [r, r] as [string, string]);
  const set = (key: string, full = false) => (v: unknown) => updateStep(withField(step, key, v), full);
  const fields = h("div", "fields");
  const out: HTMLElement[] = [fields];
  const templates = templatesAt(current, step.id);
  const varsHint = templates.length
    ? h("div", "full vars", h("span", "hint", "Insert: "), ...templates.map((t) => h("code", { title: "Copy", onclick: () => navigator.clipboard.writeText(`{{${t}}}`) }, `{{${t}}}`)))
    : undefined;

  if (!["switchTab", "openTab", "closeTab", "forEach"].includes(step.kind)) {
    fields.append(...selectField("Tab", step.tab ?? "", [["", "Current tab"], ...tabOptions], set("tab")));
  }
  const targetSection = (title: string, target: Target | undefined, onChange: (t: Target | undefined) => void, optional = false) =>
    out.push(h("h3", {}, title), targetEditor(step, target, onChange, item, optional));

  switch (step.kind) {
    case "navigate":
      fields.append(...textField("URL", step.url, set("url"), { placeholder: "https://… or {{item.url}}" }));
      if (varsHint) fields.append(varsHint);
      break;
    case "switchTab":
      fields.append(...selectField("Tab", step.role, tabOptions, set("role", true)));
      fields.append(...textField("Open at", step.url, set("url"), { placeholder: "Its start URL, if it isn't open" }));
      break;
    case "openTab":
      fields.append(...selectField("As tab", step.role, tabOptions, set("role", true)));
      fields.append(...textField("URL", step.url, set("url"), { placeholder: "https://…" }));
      if (varsHint) fields.append(varsHint);
      break;
    case "closeTab":
      fields.append(...selectField("Tab", step.role, tabOptions, set("role", true)));
      break;
    case "click": {
      fields.append(...selectField("Opens a new tab", step.opensTab ?? "", [["", "No"], ...tabOptions.map(([r]) => [r, `Yes, as ${r}`] as [string, string])], set("opensTab", true)));
      targetSection("Element", step.target, (t) => t && updateStep({ ...step, target: t }, true));
      out.push(h("h3", {}, "Then expect"));
      const until = step.until ?? {};
      const setUntil = (u: typeof until, full = false) => updateStep(withField(step, "until", u.target || u.textIncludes || u.urlMatches ? u : undefined), full);
      const expect = h("div", "fields");
      expect.append(...textField("Text appears", until.textIncludes, (v) => setUntil(withField(until as Step, "textIncludes", v) as typeof until), { placeholder: "e.g. Link copied" }));
      expect.append(h("p", "hint full", "If it doesn't appear, the click is repeated (pages often ignore clicks while loading)."));
      out.push(expect);
      out.push(targetEditor(step, until.target, (t) => setUntil(withField(until as Step, "target", t) as typeof until, true), item, true, "Element appears"));
      break;
    }
    case "fill":
      fields.append(...textField("Value", step.value, set("value"), { placeholder: "Text, or {{link}}" }));
      if (varsHint) fields.append(varsHint);
      targetSection("Field", step.target, (t) => t && updateStep({ ...step, target: t }, true));
      break;
    case "press":
      fields.append(...textField("Key", step.key, set("key"), { placeholder: "Enter, Escape, Tab, a…" }));
      targetSection("Focus first (optional)", step.target, (t) => updateStep(withField(step, "target", t), true), true);
      break;
    case "waitFor":
      fields.append(...textField("Text", step.textIncludes, set("textIncludes"), { placeholder: "Text that should appear" }));
      fields.append(...textField("URL matches", step.urlMatches, set("urlMatches"), { placeholder: "Regular expression" }));
      fields.append(...textField("Give up after (ms)", step.timeoutMs, (v) => set("timeoutMs")(v ? Number(v) : undefined), { type: "number", placeholder: "10000" }));
      if (varsHint) fields.append(varsHint);
      targetSection("Element (optional)", step.target, (t) => updateStep(withField(step, "target", t), true), true);
      break;
    case "extract":
      fields.append(...textField("Save as", step.name, set("name")));
      fields.append(...textField("Attribute", step.attr, set("attr"), { placeholder: "Text (or e.g. href)" }));
      targetSection("Element", step.target, (t) => t && updateStep({ ...step, target: t }, true));
      break;
    case "extractList":
      fields.append(...textField("Save as", step.name, set("name")));
      fields.append(...textField("Each item", step.itemSelector, set("itemSelector"), { placeholder: "CSS selector, e.g. #playlist .item" }));
      out.push(h("h3", {}, "Fields of each item"), listFieldsEditor(step));
      break;
    case "copyFromClipboard":
      fields.append(...textField("Save as", step.name, set("name")));
      fields.append(h("p", "hint full", "Takes the value the previous click copied (for example a “Copy link” button)."));
      break;
    case "forEach": {
      const lists = listNames(current);
      const options: [string, string][] = lists.map((l) => [l, l]);
      if (!lists.includes(step.list)) options.unshift([step.list, step.list || "(choose a list)"]);
      fields.append(...selectField("Repeat over", step.list, options, set("list", true)));
      fields.append(...textField("Call each", step.as, (v) => updateStep(renameItem(step, v.trim()))));
      break;
    }
    case "assert":
      fields.append(...textField("Condition", step.condition, set("condition"), { multiline: true, placeholder: "What must be true" }));
      targetSection("Element that must be there (optional)", step.target, (t) => updateStep(withField(step, "target", t), true), true);
      break;
  }
  return out;
}

/** Renames a loop's item, and the targets and templates inside the loop that refer to it. */
function renameItem(loop: Extract<Step, { kind: "forEach" }>, to: string): Step {
  const from = loop.as;
  if (!to || to === from) return { ...loop, as: to || from };
  const body = JSON.parse(
    JSON.stringify(loop.body)
      .replaceAll(`"within":${JSON.stringify(from)}`, `"within":${JSON.stringify(to)}`)
      .replace(new RegExp(`\\{\\{\\s*${from.replace(/\W/g, "\\$&")}\\.`, "g"), `{{${to}.`),
  );
  return { ...loop, as: to, body };
}

function listFieldsEditor(step: Extract<Step, { kind: "extractList" }>): HTMLElement {
  const grid = h("div", "list-fields", h("span", "hint", "Name"), h("span", "hint", "Selector in the item"), h("span", "hint", "Attribute"), h("span"));
  const entries = Object.entries(step.fields);
  const write = (rows: [string, { selector?: string; attr?: string }][], full = false) =>
    updateStep({ ...step, fields: Object.fromEntries(rows.filter(([n]) => n)) }, full);
  entries.forEach(([name, f], i) => {
    const update = (patch: Partial<{ name: string; selector: string; attr: string }>) => {
      const rows = entries.map(([n, v]) => [n, { ...v }] as [string, { selector?: string; attr?: string }]);
      if (patch.name !== undefined) rows[i][0] = patch.name;
      if (patch.selector !== undefined) rows[i][1] = withField(rows[i][1] as Step, "selector", patch.selector) as never;
      if (patch.attr !== undefined) rows[i][1] = withField(rows[i][1] as Step, "attr", patch.attr) as never;
      write(rows);
    };
    const nameInput = h("input", { value: name, "aria-label": "Field name" });
    nameInput.onchange = () => update({ name: nameInput.value.trim() });
    const sel = h("input", { value: f.selector ?? "", placeholder: "(the item)", "aria-label": `${name} selector` });
    sel.oninput = () => update({ selector: sel.value });
    const attr = h("input", { value: f.attr ?? "", placeholder: "text", "aria-label": `${name} attribute` });
    attr.oninput = () => update({ attr: attr.value });
    const remove = h("button", { class: "ghost small danger", title: "Remove field" }, "✕");
    remove.onclick = () => write(entries.filter((_, j) => j !== i), true);
    grid.append(nameInput, sel, attr, remove);
  });
  const addField = h("button", { class: "small" }, "Add field");
  addField.onclick = () => {
    let n = entries.length + 1;
    while (`field${n}` in step.fields) n++;
    write([...entries, [`field${n}`, {}]], true);
  };
  return h("div", {}, grid, h("div", "row", addField));
}

/** An element a step uses: what the recording saw, its locator parts, and a way to choose another. */
function targetEditor(step: Step, target: Target | undefined, onChange: (t: Target | undefined) => void, item: string | undefined, optional: boolean, title?: string): HTMLElement {
  const box = h("div", "target");
  if (title) box.append(h("strong", {}, title));
  const choose = h("button", { class: "small" }, target ? "Choose another element…" : "Choose an element…");
  choose.onclick = () => openPicker(step, target, onChange);
  if (!target) {
    box.append(h("div", "row", h("span", "hint", "None"), choose));
    return box;
  }
  const view = viewOf(target.source?.step);
  const bbox = bboxOf(target);
  if (view?.screenshotId) box.append(screenshot(view, bbox ? [{ bbox }] : []));
  else box.append(h("p", "hint", target.source ? "No screenshot for this step." : "Not an element from the recording."));
  const fields = h("div", "fields");
  const patch = (fp: Partial<Fingerprint>) => {
    const fingerprint = { ...target.fingerprint };
    for (const [k, v] of Object.entries(fp) as [keyof Fingerprint, string][]) {
      if (v) (fingerprint as Record<string, unknown>)[k] = v;
      else delete fingerprint[k];
    }
    onChange({ ...target, fingerprint });
  };
  fields.append(...textField("Description", target.description, (v) => onChange({ ...target, description: v })));
  fields.append(...textField("Role", target.fingerprint.role, (v) => patch({ role: v }), { placeholder: "button, link, textbox…" }));
  fields.append(...textField("Name", target.fingerprint.name, (v) => patch({ name: v }), { placeholder: "Its label or text" }));
  fields.append(...textField("CSS", target.fingerprint.css, (v) => patch({ css: v }), { placeholder: "Optional selector" }));
  if (item) {
    const id = `within-${step.id}-${title ?? "t"}`.replace(/\W+/g, "-");
    const within = h("input", { type: "checkbox", id, checked: target.within === item });
    within.onchange = () => {
      const { within: _, ...rest } = target;
      onChange(within.checked ? { ...rest, within: item } : rest);
    };
    fields.append(h("label", { htmlFor: id }, "Per item"), h("div", "row", within, h("span", "hint", `Look only inside the current ${item}`)));
  }
  box.append(fields);
  const remove = optional ? h("button", { class: "small ghost danger", onclick: () => onChange(undefined) }, "Remove") : undefined;
  box.append(h("div", "row", choose, remove));
  return box;
}

function stepActions(step: Step, inLoop: boolean): HTMLElement {
  const move = (dir: -1 | 1) => () => setWorkflow(moveStep(current, step.id, dir), true);
  const remove = () => {
    selected = undefined;
    setWorkflow(deleteStep(current, step.id), true);
  };
  return h(
    "div",
    "step-actions",
    h("button", { class: "small", onclick: move(-1) }, "Move up"),
    h("button", { class: "small", onclick: move(1) }, "Move down"),
    addMenu("Insert after", (kind) => add(kind, { after: step.id }), inLoop || step.kind === "forEach"),
    h("button", { class: "small danger", onclick: remove }, "Delete step"),
  );
}

// ---- Recording panel ----

function recordingPanel(): HTMLElement[] {
  if (!recording) {
    return [h("h2", {}, "Recording"), h("p", "empty", "This workflow wasn't compiled from a recording, so there are no screenshots or page elements to pick from.")];
  }
  const excluded = new Map((shown().notes?.excludedSteps ?? []).map((x) => [x.step, x.reason]));
  const usedBy = new Map<string, string[]>();
  for (const s of allSteps(shown().steps)) {
    const ids = new Set([...(s.basedOn ?? []), ...("target" in s && s.target?.source ? [s.target.source.step] : [])]);
    for (const id of ids) usedBy.set(id, [...(usedBy.get(id) ?? []), s.id]);
  }
  const rec = recording;
  const items = [...recSteps.values()].map((step) => {
    const view = viewOf(step.id);
    const toggle = h("button", { class: "ghost small" }, step.noise ? "Keep" : "Mark as noise");
    toggle.onclick = async () => {
      await api(`/recordings/${rec.id}/overrides/${step.events[0]}`, { method: "PUT", body: { noise: !step.noise } });
      await loadRecording(rec.id);
      renderInspector();
    };
    const users = usedBy.get(step.id) ?? [];
    return h(
      "li",
      step.noise ? "noise" : "",
      h("span", "id", step.id),
      h("div", {}, describeStep(step)),
      toggle,
      step.noise && h("span", "why", `Likely noise: ${step.noise.reason}`),
      excluded.has(step.id) && h("span", "why", `Left out by Claude: ${excluded.get(step.id)}`),
      users.length > 0 && h("span", "used", "Used by ", ...users.map((id) => h("a", { onclick: () => select(id) }, stepLabel(id)))),
      view?.screenshotId && h("div", { class: "why" }, h("img", { class: "rec-shot", src: `${API}/screenshots/${view.screenshotId}`, alt: "", loading: "lazy" })),
    );
  });
  return [
    h("h2", {}, "Recording"),
    h("p", "hint", `${rec.name}. Select a step on the left to edit it. Noise marks change what Claude sees when the recording is compiled again from the side panel.`),
    h("h3", {}, "Recorded steps"),
    h("ul", "rec", ...items),
  ];
}

// ---- Element picker ----

/** Opens the element picker on a recorded page state; calls onPick with the chosen element as a target. */
function openPicker(step: Step, previous: Target | undefined, onPick: (t: Target) => void) {
  const states = [...recSteps.values()].filter((s) => viewOf(s.id)?.inventory?.length);
  const dialog = $("picker");
  if (!states.length) {
    alert("The recording has no page elements to pick from. Fill in the role and name (or CSS) by hand.");
    return;
  }
  const preferred = previous?.source?.step ?? sourceOf(step);
  let stateId = states.find((s) => s.id === preferred)?.id ?? states[0].id;
  const loc = locate(current.steps, step.id);
  const item = loc?.loop?.as;
  const close = () => {
    dialog.hidden = true;
    dialog.replaceChildren();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);

  const draw = () => {
    const view = viewOf(stateId)!;
    const inventory = view.inventory ?? [];
    const pick = (i: number) => {
      // Per-item when the step's current element is, or when picking a new one inside a loop.
      const within = previous ? (previous.within ? item : undefined) : item;
      onPick(pickedTarget(inventory[i], { step: stateId, inventoryIndex: i }, previous, within));
      close();
    };
    const stateSelect = h("select", { "aria-label": "Page state" }, ...states.map((s) => h("option", { value: s.id, selected: s.id === stateId }, `${s.id} · ${describeStep(s)}`)));
    stateSelect.onchange = () => ((stateId = stateSelect.value), draw());
    const search = h("input", { type: "search", placeholder: "Filter elements", "aria-label": "Filter elements" });
    const list = h("ul");
    const rows: HTMLLIElement[] = [];
    const boxes = new Map<number, HTMLElement>();
    const hot = (i: number, on: boolean) => {
      rows[i]?.classList.toggle("hot", on);
      boxes.get(i)?.classList.toggle("hot", on);
    };
    inventory.forEach((el, i) => {
      const fp = el.fingerprint;
      const isCurrent = previous?.source?.step === stateId && previous.source.inventoryIndex === i;
      const row = h("li", { class: isCurrent ? "current" : "", onclick: () => pick(i), onmouseenter: () => hot(i, true), onmouseleave: () => hot(i, false) },
        h("span", "role", fp.role ?? el.tag), h("span", {}, fp.name ?? fp.href ?? fp.css ?? ""));
      rows[i] = row;
      list.append(row);
    });
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach((row) => (row.hidden = Boolean(q) && !row.textContent!.toLowerCase().includes(q)));
    };
    const pane = h("div", "view");
    if (view.screenshotId) {
      const shot = screenshot(view, inventory.flatMap((el, i) => (el.fingerprint.bbox ? [{
        bbox: el.fingerprint.bbox, cls: "faint", title: `${el.fingerprint.role ?? el.tag} ${el.fingerprint.name ?? ""}`,
        onClick: () => pick(i), onHover: (on: boolean) => hot(i, on), placed: (box: HTMLElement) => boxes.set(i, box),
      }] : [])));
      pane.append(shot);
    } else {
      pane.append(h("p", "empty", "No screenshot of this page state; pick from the list."));
    }
    dialog.replaceChildren(
      h("div", { class: "dialog", role: "dialog", "aria-label": "Choose an element" },
        h("header", {}, h("strong", {}, "Choose an element"), stateSelect, h("span", "hint", `${inventory.length} elements`), h("div", "spacer"),
          h("button", { class: "ghost", onclick: close }, "Cancel")),
        h("div", "panes", pane, h("div", "elements", search, list)),
      ),
    );
    dialog.onclick = (e) => e.target === dialog && close();
    search.focus();
  };
  dialog.hidden = false;
  draw();
}

// ---- Actions ----

async function save(): Promise<boolean> {
  try {
    const res = await api<{ workflow: Workflow }>(`/workflows/${workflowId}`, { method: "PUT", body: current });
    saved = res.workflow;
    current = structuredClone(res.workflow);
    render();
    return true;
  } catch (err) {
    alert(`Could not save: ${(err as Error).message}`);
    return false;
  }
}

async function run(options: object) {
  if (dirty() && !(await save())) return;
  try {
    await api(`/workflows/${workflowId}/runs`, { method: "POST", body: options });
    $("ask-status").textContent = "Run started; follow it in the side panel.";
  } catch (err) {
    alert(`Could not start: ${(err as Error).message}`);
  }
}

async function ask() {
  const request = $<HTMLTextAreaElement>("request").value.trim();
  if (!request) return $("request").focus();
  // Claude starts from the stored version, so hand edits are saved first.
  if (dirty() && !(await save())) return;
  const status = $("ask-status");
  const button = $<HTMLButtonElement>("ask-go");
  button.disabled = true;
  status.textContent = "Claude is working on it; this can take a minute…";
  try {
    const res = await api<{ proposalId: string; workflow: Workflow }>(`/workflows/${workflowId}/propose`, { method: "POST", body: { request } });
    proposal = { id: res.proposalId, workflow: res.workflow, diff: diffSteps(current.steps, res.workflow.steps) };
    status.textContent = "";
    render();
  } catch (err) {
    status.textContent = `Could not change it: ${(err as Error).message}`;
  } finally {
    button.disabled = false;
  }
}

async function acceptProposal() {
  if (!proposal) return;
  try {
    const wf = await api<Workflow>(`/workflows/${workflowId}/proposals/${proposal.id}/accept`, { method: "POST" });
    saved = wf;
    current = structuredClone(wf);
    proposal = undefined;
    $<HTMLTextAreaElement>("request").value = "";
    render();
  } catch (err) {
    alert(`Could not accept: ${(err as Error).message}`);
  }
}

async function discardProposal() {
  if (!proposal) return;
  await api(`/workflows/${workflowId}/proposals/${proposal.id}`, { method: "DELETE" }).catch(() => {});
  proposal = undefined;
  render();
}

async function loadRecording(id: string) {
  recording = await api<Recording>(`/recordings/${id}`);
  recSteps = new Map(mergeEvents(recording.events, recording.overrides).map((s) => [s.id, s]));
}

async function load() {
  if (!workflowId) return void (document.body.textContent = "No workflow given.");
  try {
    saved = await api<Workflow>(`/workflows/${workflowId}`);
  } catch (err) {
    document.body.textContent = `Could not load the workflow: ${(err as Error).message}. Is the server running (pnpm dev:server)?`;
    return;
  }
  current = structuredClone(saved);
  if (saved.recordingId) await loadRecording(saved.recordingId).catch(() => (recording = undefined));
  document.title = `${saved.name} · Workflow editor`;
  render();
}

$<HTMLInputElement>("name").oninput = (e) => setWorkflow({ ...current, name: (e.target as HTMLInputElement).value });
$("save").onclick = () => save();
$("revert").onclick = () => {
  current = structuredClone(saved);
  if (selected && !locate(current.steps, selected)) selected = undefined;
  render();
};
$("dry").onclick = () => run({ limit: 1 });
$("run").onclick = () => run({});
$("ask-go").onclick = ask;
$<HTMLTextAreaElement>("request").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
};
$("proposal-accept").onclick = acceptProposal;
$("proposal-discard").onclick = discardProposal;
document.addEventListener("keydown", (e) => {
  if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (dirty() && !proposal) save();
  }
});
addEventListener("beforeunload", (e) => {
  if (current && dirty()) e.preventDefault();
});

load();
