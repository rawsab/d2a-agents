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
import {
  AppWindow,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ChevronDown,
  Clipboard,
  Crosshair,
  Eye,
  EyeOff,
  Globe,
  Hourglass,
  type IconNode,
  Keyboard,
  ListTree,
  MousePointerClick,
  PanelTopClose,
  Plus,
  Redo2,
  Repeat,
  ScanText,
  Search,
  ShieldCheck,
  Sparkles,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide";
import { API_URL as API } from "../config.js";
import { $, type Child, h, icon, iconButton, setUpTheme, toast } from "../ui/dom.js";
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
  moveStepTo,
  newId,
  pickedTarget,
  renameTab,
  replaceStep,
  templatesAt,
} from "./model.js";

const KIND_ICONS: Record<StepKind, IconNode> = {
  navigate: Globe,
  switchTab: ArrowLeftRight,
  openTab: AppWindow,
  closeTab: PanelTopClose,
  click: MousePointerClick,
  fill: TextCursorInput,
  press: Keyboard,
  waitFor: Hourglass,
  extract: ScanText,
  extractList: ListTree,
  copyFromClipboard: Clipboard,
  forEach: Repeat,
  assert: ShieldCheck,
};

/** Placeholders for recorded steps that have no screenshot. */
const REC_ICONS: Record<SemanticStep["kind"], IconNode> = {
  openTab: AppWindow,
  switchTab: ArrowLeftRight,
  navigate: Globe,
  click: MousePointerClick,
  fill: TextCursorInput,
  press: Keyboard,
  copy: Clipboard,
  submit: MousePointerClick,
};

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

type PanelTab = "step" | "recording" | "settings";

const workflowId = new URLSearchParams(location.search).get("id") ?? "";
let saved: Workflow;
let current: Workflow;
let selected: string | undefined;
let panelTab: PanelTab = "recording";
let proposal: { id: string; workflow: Workflow; diff: StepDiff } | undefined;
let recording: Recording | undefined;
let recSteps = new Map<string, SemanticStep>();

/** Undo history: earlier versions, and versions undone since the last edit. */
let past: Workflow[] = [];
let future: Workflow[] = [];
/** Typing in one field becomes one undo step, not one per keystroke. */
let typing: { key: string; at: number } | undefined;
const TYPING_MERGE_MS = 1500;

const dirty = () => JSON.stringify(current) !== JSON.stringify(saved);
/** The version shown: Claude's proposal while one is open, else the one being edited. */
const shown = () => proposal?.workflow ?? current;

/** Records an edit. `typing` merges consecutive edits of one field into one undo step. */
function change(next: Workflow, opts: { typing?: string; full?: boolean } = {}) {
  const now = Date.now();
  const merge = opts.typing && typing?.key === opts.typing && now - typing.at < TYPING_MERGE_MS;
  if (!merge) {
    past.push(current);
    if (past.length > 200) past.shift();
  }
  typing = opts.typing ? { key: opts.typing, at: now } : undefined;
  future = [];
  current = next;
  if (opts.full) render();
  else refresh();
}

function undo() {
  const prev = past.pop();
  if (!prev || proposal) return;
  future.push(current);
  current = prev;
  typing = undefined;
  if (selected && !locate(current.steps, selected)) selected = undefined;
  render();
}

function redo() {
  const next = future.pop();
  if (!next || proposal) return;
  past.push(current);
  current = next;
  typing = undefined;
  render();
}

/** The current version of a step, by id (inputs must never edit a stale copy). */
function stepById(id: string): Step | undefined {
  const loc = locate(current.steps, id);
  return loc?.container[loc.index];
}

function patchStep(id: string, fn: (s: Step) => Step, opts: { typing?: string; full?: boolean } = {}) {
  const step = stepById(id);
  if (step) change(replaceStep(current, fn(step)), opts);
}

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

/** The element a step acted on in its own recorded step, for crops. */
function stepBox(step: Step, view: View): Fingerprint["bbox"] {
  const target = "target" in step ? step.target : undefined;
  if (target?.source?.step === view.stepId) return bboxOf(target);
  return "target" in view.step ? view.step.target?.bbox : undefined;
}

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

/**
 * A crop of a screenshot around an element (or the top of the page), with the element outlined.
 * `minWidth` is how much of the page, in CSS pixels, the crop shows at least.
 */
function crop(view: View, bbox: Fingerprint["bbox"], cls: string, minWidth: number): HTMLElement {
  const frame = h("div", cls);
  const img = h("img", { src: `${API}/screenshots/${view.screenshotId}`, alt: "", draggable: false });
  frame.append(img);
  const place = () => {
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    if (!fw || !fh) return void requestAnimationFrame(place);
    const page = pageSize(img, view);
    const rw = Math.min(page.w, Math.max(minWidth, (bbox?.w ?? 0) * 3));
    const rh = (rw * fh) / fw;
    const cx = bbox ? bbox.x + bbox.w / 2 : rw / 2;
    const cy = bbox ? bbox.y + bbox.h / 2 : rh / 2;
    const rx = Math.max(0, Math.min(cx - rw / 2, page.w - rw));
    const ry = Math.max(0, Math.min(cy - rh / 2, page.h - rh));
    const scale = fw / rw;
    Object.assign(img.style, { width: `${page.w * scale}px`, left: `${-rx * scale}px`, top: `${-ry * scale}px` });
    if (bbox) {
      const pad = 3;
      const box = h("div", "box");
      Object.assign(box.style, {
        left: `${(bbox.x - rx) * scale - pad}px`, top: `${(bbox.y - ry) * scale - pad}px`,
        width: `${bbox.w * scale + pad * 2}px`, height: `${bbox.h * scale + pad * 2}px`,
      });
      frame.append(box);
    }
  };
  onLoaded(img, () => requestAnimationFrame(place));
  return frame;
}

type Box = {
  bbox: NonNullable<Fingerprint["bbox"]>;
  title?: string;
  onClick?: () => void;
  onHover?: (on: boolean) => void;
  placed?: (box: HTMLElement) => void;
};

/** A whole screenshot with clickable element boxes, positioned in % so it scales with the image. */
function screenshot(view: View, boxes: Box[]): HTMLElement {
  const wrap = h("div", "shot");
  const img = h("img", { src: `${API}/screenshots/${view.screenshotId}`, alt: "", draggable: false });
  wrap.append(img);
  onLoaded(img, () => {
    const { w, h: ph } = pageSize(img, view);
    for (const b of boxes) {
      if (b.bbox.y >= ph || b.bbox.x >= w) continue; // outside what the screenshot shows
      const box = h("div", { class: "box", title: b.title, onclick: b.onClick, onmouseenter: () => b.onHover?.(true), onmouseleave: () => b.onHover?.(false) });
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

// ---- Step titles ----

const code = (s: string) => h("code", {}, s);
const el = (s: string) => h("span", "el", s);

/** A readable title: plain verbs, elements as tokens, values and variables as code. */
function titleOf(step: Step): Child[] {
  switch (step.kind) {
    case "navigate":
      return ["Go to ", step.url ? code(step.url) : "…"];
    case "switchTab":
      return ["Switch to the ", el(step.role), " tab"];
    case "openTab":
      return ["Open ", el(step.role), " at ", step.url ? code(step.url) : "…"];
    case "closeTab":
      return ["Close the ", el(step.role), " tab"];
    case "click":
      return ["Click ", el(step.target.description), step.opensTab && " to open ", step.opensTab && el(step.opensTab)];
    case "fill":
      return ["Fill ", el(step.target.description), " with ", step.value ? code(step.value) : "nothing"];
    case "press":
      return ["Press ", h("kbd", {}, step.key || "…"), step.target && " in ", step.target && el(step.target.description)];
    case "waitFor": {
      const element = step.target && step.target.fingerprint.css !== "body" ? step.target.description : undefined;
      if (step.textIncludes) return ["Wait for ", code(step.textIncludes), element && " in ", element && el(element)];
      if (element) return ["Wait for ", el(element)];
      return ["Wait for the URL to match ", code(step.urlMatches ?? "…")];
    }
    case "extract":
      return ["Read ", el(step.target.description), " into ", code(step.name)];
    case "extractList":
      return ["Collect ", code(step.name), " from ", code(step.itemSelector || "…")];
    case "copyFromClipboard":
      return ["Save the copied value as ", code(step.name)];
    case "forEach":
      return ["For each ", code(step.as), " in ", code(step.list || "…")];
    case "assert":
      return ["Check ", step.condition || "…"];
  }
}

// ---- Rendering ----

function render() {
  renderBar();
  renderProposal();
  renderRail();
  renderPanel();
}

/** After a field edit: everything but the panel, so the input being typed in keeps focus. */
function refresh() {
  renderBar();
  renderRail();
}

function renderBar() {
  const name = $<HTMLInputElement>("name");
  if (document.activeElement !== name) name.value = shown().name;
  name.disabled = Boolean(proposal);
  const state = $("state");
  state.textContent = proposal ? "Reviewing a proposal" : dirty() ? "Unsaved changes" : "Saved";
  state.classList.toggle("dirty", dirty() && !proposal);
  const problems = checkWorkflow(current);
  const pill = $("problems-pill");
  pill.hidden = problems.length === 0 || Boolean(proposal);
  pill.replaceChildren(icon(TriangleAlert), `${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  pill.title = "Go to the first problem";
  $<HTMLButtonElement>("save").disabled = !dirty() || Boolean(proposal);
  $<HTMLButtonElement>("undo").disabled = past.length === 0 || Boolean(proposal);
  $<HTMLButtonElement>("redo").disabled = future.length === 0 || Boolean(proposal);
  for (const id of ["dry", "run"]) $<HTMLButtonElement>(id).disabled = Boolean(proposal);
  $("composer").hidden = Boolean(proposal);
}

function renderProposal() {
  $("proposal").hidden = !proposal;
  if (!proposal) return;
  const statuses = [...proposal.diff.status.values()];
  const added = statuses.filter((s) => s === "added").length;
  const changed = statuses.filter((s) => s === "changed").length;
  const removed = proposal.diff.removed.length;
  $("proposal-counts").replaceChildren(
    added ? h("span", "add", `${added} added`) : "",
    changed ? h("span", "chg", `${changed} changed`) : "",
    removed ? h("span", "del", `${removed} removed`) : "",
    !added && !changed && !removed ? "No step changes" : "",
  );
  const notes = proposal.workflow.notes;
  $("proposal-summary").textContent = notes?.summary ?? "";
  $("proposal-notes").replaceChildren(
    ...(notes?.problems ?? []).map((p) => h("li", "problem", p)),
    ...(notes?.questions ?? []).map((q) => h("li", {}, q)),
    ...(notes?.assumptions ?? []).map((a) => h("li", {}, a)),
  );
}

function problemsByStep(): Map<string, WorkflowProblem[]> {
  const map = new Map<string, WorkflowProblem[]>();
  for (const p of checkWorkflow(shown())) if (p.stepId) map.set(p.stepId, [...(map.get(p.stepId) ?? []), p]);
  return map;
}

function renderRail() {
  const wf = shown();
  const rail = $<HTMLOListElement>("steps");
  const problems = problemsByStep();
  const editable = !proposal;

  const nodes = (steps: Step[], loop?: string): HTMLElement[] => {
    const out: HTMLElement[] = [];
    if (loop && editable) out.push(gap({ after: null, loop }));
    steps.forEach((step, i) => {
      const card = stepCard(step, problems.get(step.id));
      const dot = h("div", "dot", icon(KIND_ICONS[step.kind]));
      const status = proposal?.diff.status.get(step.id);
      const cls = ["node", step.kind === "forEach" && "loop", selected === step.id && "selected", status !== "unchanged" && status].filter(Boolean).join(" ");
      const node = h("li", { class: cls, "data-step": step.id }, dot, card);
      if (step.kind === "forEach") {
        const branch = h("ol", "branch", ...nodes(step.body, step.id));
        if (editable) branch.append(endButton("Add a step to the loop", true, step.id));
        node.append(branch);
      }
      out.push(node);
      if (editable && i < steps.length - 1) out.push(gap({ after: step.id }));
    });
    return out;
  };

  rail.replaceChildren(...nodes(wf.steps));
  if (wf.steps.length === 0) {
    rail.append(h("li", "empty-state", h("strong", {}, "No steps yet"), "Add one below, or ask Claude above."));
  }
  if (editable) rail.append(endButton("Add a step", false));
  if (proposal?.diff.removed.length) {
    rail.append(h("li", "rail-title", "Removed"));
    for (const step of proposal.diff.removed) {
      rail.append(h("li", "node removed", h("div", "dot", icon(KIND_ICONS[step.kind])), stepCard(step, undefined, "removed")));
    }
  }
}

/** The "+" between two steps. */
function gap(where: { after: string | null; loop?: string }): HTMLElement {
  const li = h("li", "gap");
  const button = h("button", { type: "button", "aria-label": "Insert a step here", title: "Insert a step here" }, icon(Plus));
  button.onclick = () => {
    li.classList.add("open");
    const inLoop = Boolean(where.loop) || Boolean(where.after && locate(current.steps, where.after)?.loop);
    openMenu(button, inLoop, (kind) => add(kind, where), () => li.classList.remove("open"));
  };
  li.append(button);
  return li;
}

function endButton(label: string, inLoop: boolean, loop?: string): HTMLElement {
  const button = h("button", { type: "button" }, icon(Plus), label);
  button.onclick = () => openMenu(button, inLoop, (kind) => add(kind, { after: null, loop, append: true }));
  return h("li", "gap end", button);
}

function stepCard(step: Step, problems?: WorkflowProblem[], forced?: "removed"): HTMLElement {
  const status = forced ?? proposal?.diff.status.get(step.id);
  const view = viewOf(ownSource(step));
  const editable = !proposal && !forced;
  const card = h("div", { class: "card" });
  card.onclick = () => select(step.id);

  const before = status === "changed" ? proposal?.diff.before.get(step.id) : undefined;
  const wasText = before && describeWorkflowStep(before) !== describeWorkflowStep(step) ? `was: ${describeWorkflowStep(before)}` : undefined;
  const meta = h(
    "div",
    "meta",
    step.tab && h("span", {}, `in ${step.tab}`),
    status && status !== "unchanged" && h("span", "tag", status === "added" ? "Added" : status === "changed" ? "Changed" : "Removed"),
    wasText && h("span", "was", wasText),
    ...(problems ?? []).map((p) => h("span", "problem", icon(TriangleAlert), p.message)),
  );
  const right = h("div", "right");
  if (editable) {
    right.append(
      h("div", "actions",
        iconButton(ArrowUp, "Move up", (e) => (e.stopPropagation(), move(step.id, -1))),
        iconButton(ArrowDown, "Move down", (e) => (e.stopPropagation(), move(step.id, 1))),
        iconButton(Trash2, "Delete", (e) => (e.stopPropagation(), remove(step.id)), "icon-btn small danger"),
      ),
    );
    makeDraggable(card, step.id);
  }
  if (view?.screenshotId) right.append(crop(view, stepBox(step, view), "thumb", 360));
  card.append(h("div", {}, h("div", "title", ...titleOf(step)), meta.childElementCount ? meta : undefined), right);
  return card;
}

// ---- Drag and drop ----

let dragging: string | undefined;

function makeDraggable(card: HTMLElement, id: string) {
  card.draggable = true;
  const node = () => card.closest(".node");
  card.ondragstart = (e) => {
    e.stopPropagation(); // a step inside a loop, not the loop
    dragging = id;
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    requestAnimationFrame(() => node()?.classList.add("dragging"));
  };
  card.ondragend = () => {
    dragging = undefined;
    node()?.classList.remove("dragging");
    document.querySelectorAll(".drop-before, .drop-after").forEach((c) => c.classList.remove("drop-before", "drop-after"));
  };
  const position = (e: DragEvent) => {
    const r = card.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  card.ondragover = (e) => {
    if (!dragging || dragging === id) return;
    e.preventDefault();
    const pos = position(e);
    card.classList.toggle("drop-before", pos === "before");
    card.classList.toggle("drop-after", pos === "after");
  };
  card.ondragleave = () => card.classList.remove("drop-before", "drop-after");
  card.ondrop = (e) => {
    e.preventDefault();
    card.classList.remove("drop-before", "drop-after");
    if (!dragging || dragging === id) return;
    const next = moveStepTo(current, dragging, id, position(e));
    if (JSON.stringify(next) !== JSON.stringify(current)) change(next, { full: true });
  };
}

// ---- Edits ----

function move(id: string, dir: -1 | 1) {
  change(moveStep(current, id, dir), { full: true });
  document.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"] > .card`)?.scrollIntoView({ block: "nearest" });
}

function remove(id: string) {
  const step = stepById(id);
  if (!step) return;
  const i = allSteps(current.steps).findIndex((s) => s.id === id);
  if (selected === id) {
    // Keep the keyboard flow going: select what takes its place.
    const after = allSteps(deleteStep(current, id).steps).map((s) => s.id);
    selected = after[Math.min(i, after.length - 1)];
  }
  change(deleteStep(current, id), { full: true });
  const what = step.kind === "forEach" && step.body.length ? `Loop and its ${step.body.length} steps deleted` : "Step deleted";
  toast(what, { action: { label: "Undo", run: undo } });
}

function add(kind: StepKind, where: { after: string | null; loop?: string; append?: boolean }) {
  const step = blankStep(kind, newId(current), current);
  const next = where.append ? appendStep(current, step, where.loop) : insertStep(current, step, where.after, where.loop);
  selected = step.id;
  panelTab = "step";
  change(next, { full: true });
  // A new step on an element starts by choosing the element.
  if ("target" in step && step.target) {
    openPicker(step, step.target, (t) => patchStep(step.id, (s) => ({ ...s, target: t }) as Step, { full: true }));
  } else {
    requestAnimationFrame(() => $("panel-body").querySelector<HTMLElement>(".fields input, .fields select")?.focus());
  }
}

function select(id: string | undefined) {
  selected = id;
  if (id) panelTab = "step";
  renderRail();
  renderPanel();
  if (id) document.querySelector(`[data-step="${CSS.escape(id)}"] > .card`)?.scrollIntoView({ block: "nearest" });
}

// ---- Add-step menu ----

let closeMenu: (() => void) | undefined;

function openMenu(anchor: HTMLElement, inLoop: boolean, onPick: (kind: StepKind) => void, onClose?: () => void) {
  closeMenu?.();
  const menu = $("menu");
  const kinds = (Object.keys(KIND_LABELS) as StepKind[]).filter((k) => !(inLoop && k === "forEach"));
  const search = h("input", { type: "text", placeholder: "Add a step…", "aria-label": "Search step types" });
  const list = h("ul", { role: "listbox", "aria-label": "Step types" });
  let matches: StepKind[] = kinds;
  let active = 0;
  /** Moves the highlight without rebuilding the list (rebuilding under the pointer makes it flicker). */
  const highlight = () => {
    [...list.children].forEach((li, i) => {
      li.classList.toggle("active", i === active);
      li.setAttribute("aria-selected", String(i === active));
      if (i === active) li.scrollIntoView({ block: "nearest" });
    });
  };
  const draw = () => {
    list.replaceChildren(
      ...matches.map((kind, i) =>
        h("li", { role: "option", onclick: () => pick(kind), onmouseenter: () => ((active = i), highlight()) }, icon(KIND_ICONS[kind]), KIND_LABELS[kind]),
      ),
    );
    highlight();
  };
  const close = () => {
    menu.hidden = true;
    menu.replaceChildren();
    document.removeEventListener("mousedown", outside, true);
    closeMenu = undefined;
    onClose?.();
  };
  const pick = (kind: StepKind) => {
    close();
    onPick(kind);
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    matches = kinds.filter((k) => KIND_LABELS[k].toLowerCase().includes(q));
    active = 0;
    draw();
  };
  search.onkeydown = (e) => {
    if (e.key === "ArrowDown") active = Math.min(active + 1, matches.length - 1);
    else if (e.key === "ArrowUp") active = Math.max(active - 1, 0);
    else if (e.key === "Enter" && matches[active]) return pick(matches[active]);
    else if (e.key === "Escape") return close();
    else return;
    e.preventDefault();
    highlight();
  };
  menu.replaceChildren(search, list);
  draw();
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6 + menu.offsetHeight > innerHeight ? Math.max(8, r.top - 6 - menu.offsetHeight) : r.bottom + 6;
  Object.assign(menu.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`, top: `${top}px` });
  document.addEventListener("mousedown", outside, true);
  closeMenu = close;
  search.focus();
}

// ---- Panel ----

function renderPanel() {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === panelTab));
  }
  const body = $("panel-body");
  if (panelTab === "recording") return void body.replaceChildren(...recordingPanel());
  if (panelTab === "settings") return void body.replaceChildren(...settingsPanel());
  const loc = selected ? locate(shown().steps, selected) : undefined;
  if (!loc) {
    return void body.replaceChildren(
      h("p", { class: "panel-title", style: "margin-top:0" }, "Select a step to edit it."),
      section("Shortcuts", shortcuts()),
    );
  }
  const step = loc.container[loc.index];
  const head = h("div", "panel-head", h("div", "dot", icon(KIND_ICONS[step.kind])), h("h2", {}, KIND_LABELS[step.kind]), h("span", "id", step.id));
  if (proposal) {
    const before = proposal.diff.before.get(step.id);
    return void body.replaceChildren(
      head,
      h("div", "section readonly", h("h3", {}, "After"), h("p", {}, ...titleOf(step))),
      h("div", "section readonly", h("h3", {}, "Before"), before ? h("p", "was", ...titleOf(before)) : h("p", "help", "This step is new.")),
    );
  }
  body.replaceChildren(head, ...stepFields(step, loc.loop?.as), stepActions(step));
}

function shortcuts(): HTMLElement {
  const rows: [string[], string][] = [
    [["↑", "↓"], "Select the previous or next step"],
    [["⌥↑", "⌥↓"], "Move the selected step"],
    [["⌫"], "Delete the selected step"],
    [["⌘Z", "⇧⌘Z"], "Undo, redo"],
    [["⌘K"], "Ask Claude"],
    [["⌘S"], "Save"],
  ];
  return h(
    "div",
    { class: "fields", style: "grid-template-columns: 96px 1fr" },
    ...rows.flatMap(([keys, what]) => [h("span", {}, ...keys.map((k) => h("kbd", { style: "margin-right:4px" }, k))), h("span", "help", what)]),
  );
}

let fieldSeq = 0;

/** A labelled input bound to one field. */
function textField(label: string, value: string | number | undefined, onInput: (v: string) => void, opts: { placeholder?: string; type?: string; mono?: boolean; idSuffix?: string } = {}) {
  const id = `f-${label.replace(/\W+/g, "-")}${opts.idSuffix ?? ""}`;
  const input = h("input", { id, type: opts.type ?? "text", placeholder: opts.placeholder ?? "", class: opts.mono ? "mono" : "", spellcheck: false });
  input.value = value === undefined ? "" : String(value);
  input.oninput = () => onInput(input.value);
  return [h("label", { htmlFor: id }, label), input];
}

function selectField(label: string, value: string, options: [string, string][], onChange: (v: string) => void) {
  const id = `f-${label.replace(/\W+/g, "-")}-${++fieldSeq}`;
  const sel = h("select", { id }, ...options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
  sel.onchange = () => onChange(sel.value);
  return [h("label", { htmlFor: id }, label), sel];
}

/** Sets or clears an optional field. */
function withField<S extends object>(obj: S, key: string, value: unknown): S {
  const next = { ...obj } as Record<string, unknown>;
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next as S;
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h("div", "section", h("h3", {}, title), ...children);
}

function stepFields(step: Step, item: string | undefined): HTMLElement[] {
  const id = step.id;
  const tabOptions = Object.keys(current.tabs).map((r) => [r, r] as [string, string]);
  /** Binds an input to a field of the current step; typing in it is one undo step. */
  const set = (key: string, full = false) => (v: unknown) =>
    patchStep(id, (s) => withField(s, key, v), full ? { full: true } : { typing: `${id}:${key}` });
  const fields = h("div", "fields");
  const out: HTMLElement[] = [section("Details", fields)];
  const templates = templatesAt(current, id);
  const insertable = templates.length
    ? h("div", "full chips", h("span", "help", "Available:"), ...templates.map((t) =>
        h("button", { type: "button", title: "Copy", onclick: () => (navigator.clipboard.writeText(`{{${t}}}`), toast(`Copied {{${t}}}`)) }, `{{${t}}}`)))
    : undefined;
  /** An element section; edits always apply to the current version of the step's field. */
  const element = (title: string, key: "target" | "until.target", optional = false) => {
    const get = () => {
      const s = stepById(id) as (Step & { target?: Target; until?: { target?: Target } }) | undefined;
      return key === "target" ? s?.target : s?.until?.target;
    };
    const put = (t: Target | undefined, opts: { typing?: string; full?: boolean }) =>
      patchStep(id, (s) => {
        if (key === "target") return withField(s, "target", t);
        const until = withField((s as { until?: object }).until ?? {}, "target", t);
        return withField(s, "until", Object.keys(until).length ? until : undefined);
      }, opts);
    out.push(section(title, targetEditor(step, get, put, item, optional, key)));
  };

  if (!["switchTab", "openTab", "closeTab", "forEach"].includes(step.kind)) {
    fields.append(...selectField("Tab", step.tab ?? "", [["", "Current tab"], ...tabOptions], set("tab", true)));
  }

  switch (step.kind) {
    case "navigate":
      fields.append(...textField("URL", step.url, set("url"), { placeholder: "https://… or {{item.url}}", mono: true }));
      if (insertable) fields.append(insertable);
      break;
    case "switchTab":
      fields.append(...selectField("Tab", step.role, tabOptions, set("role", true)));
      fields.append(...textField("Open at", step.url, set("url"), { placeholder: "Its start URL", mono: true }));
      break;
    case "openTab":
      fields.append(...selectField("As tab", step.role, tabOptions, set("role", true)));
      fields.append(...textField("URL", step.url, set("url"), { placeholder: "https://…", mono: true }));
      if (insertable) fields.append(insertable);
      break;
    case "closeTab":
      fields.append(...selectField("Tab", step.role, tabOptions, set("role", true)));
      break;
    case "click": {
      fields.append(...selectField("Opens a tab", step.opensTab ?? "", [["", "No"], ...tabOptions.map(([r]) => [r, `Yes, as ${r}`] as [string, string])], set("opensTab", true)));
      element("Element", "target");
      const until = h("div", "fields");
      until.append(...textField("Text appears", step.until?.textIncludes, (v) =>
        patchStep(id, (s) => {
          const u = withField((s as { until?: object }).until ?? {}, "textIncludes", v);
          return withField(s, "until", Object.keys(u).length ? u : undefined);
        }, { typing: `${id}:until.text` }), { placeholder: "e.g. Link copied" }));
      until.append(h("p", "help full", "If nothing expected appears, the click is repeated. Pages often ignore clicks while loading."));
      out.push(section("Then expect", until));
      element("Element appears", "until.target", true);
      break;
    }
    case "fill":
      fields.append(...textField("Value", step.value, set("value"), { placeholder: "Text or {{variable}}", mono: true }));
      if (insertable) fields.append(insertable);
      element("Field", "target");
      break;
    case "press":
      fields.append(...textField("Key", step.key, set("key"), { placeholder: "Enter, Escape, Tab, a…" }));
      element("Focus first", "target", true);
      break;
    case "waitFor":
      fields.append(...textField("Text", step.textIncludes, set("textIncludes"), { placeholder: "Text that should appear", mono: true }));
      fields.append(...textField("URL matches", step.urlMatches, set("urlMatches"), { placeholder: "Regular expression", mono: true }));
      fields.append(...textField("Timeout", step.timeoutMs, (v) => set("timeoutMs")(v ? Number(v) : undefined), { type: "number", placeholder: "10000 ms" }));
      if (insertable) fields.append(insertable);
      element("Element", "target", true);
      break;
    case "extract":
      fields.append(...textField("Save as", step.name, set("name"), { mono: true }));
      fields.append(...textField("Attribute", step.attr, set("attr"), { placeholder: "Text, or e.g. href", mono: true }));
      element("Element", "target");
      break;
    case "extractList":
      fields.append(...textField("Save as", step.name, set("name"), { mono: true }));
      fields.append(...textField("Each item", step.itemSelector, set("itemSelector"), { placeholder: "CSS, e.g. #playlist .item", mono: true }));
      out.push(section("Fields of each item", listFieldsEditor(step)));
      break;
    case "copyFromClipboard":
      fields.append(...textField("Save as", step.name, set("name"), { mono: true }));
      fields.append(h("p", "help full", "Takes the value the previous click copied, such as a “Copy link” button."));
      break;
    case "forEach": {
      const lists = listNames(current);
      const options: [string, string][] = lists.map((l) => [l, l]);
      if (!lists.includes(step.list)) options.unshift([step.list, step.list || "Choose a list"]);
      fields.append(...selectField("Repeat over", step.list, options, set("list", true)));
      fields.append(...textField("Call each", step.as, (v) => patchStep(id, (s) => renameItem(s as Extract<Step, { kind: "forEach" }>, v.trim()), { typing: `${id}:as` }), { mono: true }));
      break;
    }
    case "assert":
      fields.append(...textField("Condition", step.condition, set("condition"), { placeholder: "What must be true" }));
      element("Element that must be there", "target", true);
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
  const id = step.id;
  const grid = h("div", "list-fields", h("span", "head", "Name"), h("span", "head", "Selector in the item"), h("span", "head", "Attribute"), h("span"));
  type Row = [string, { selector?: string; attr?: string }];
  const rows = (): Row[] => {
    const s = stepById(id);
    return s?.kind === "extractList" ? Object.entries(s.fields).map(([n, f]) => [n, { ...f }] as Row) : [];
  };
  const write = (next: Row[], opts: { typing?: string; full?: boolean }) =>
    patchStep(id, (s) => ({ ...s, fields: Object.fromEntries(next.filter(([n]) => n)) }) as Step, opts);
  Object.entries(step.fields).forEach(([name, f], i) => {
    const update = (key: "name" | "selector" | "attr", v: string) => {
      const next = rows();
      if (key === "name") next[i][0] = v;
      else next[i][1] = withField(next[i][1], key, v);
      write(next, key === "name" ? { full: true } : { typing: `${id}:fields.${i}.${key}` });
    };
    const nameInput = h("input", { value: name, class: "mono", "aria-label": "Field name" });
    nameInput.onchange = () => update("name", nameInput.value.trim());
    const sel = h("input", { value: f.selector ?? "", placeholder: "The item", class: "mono", "aria-label": `${name} selector` });
    sel.oninput = () => update("selector", sel.value);
    const attr = h("input", { value: f.attr ?? "", placeholder: "text", class: "mono", "aria-label": `${name} attribute` });
    attr.oninput = () => update("attr", attr.value);
    grid.append(nameInput, sel, attr, iconButton(X, "Remove field", () => write(rows().filter((_, j) => j !== i), { full: true })));
  });
  const addField = h("button", { class: "btn small", type: "button" }, icon(Plus), "Add field");
  addField.onclick = () => {
    const next = rows();
    let n = next.length + 1;
    while (next.some(([k]) => k === `field${n}`)) n++;
    write([...next, [`field${n}`, {}]], { full: true });
  };
  return h("div", {}, grid, h("div", { style: "margin-top:8px" }, addField));
}

/** An element a step uses: what the recording saw, its description and locator, and a way to choose another. */
function targetEditor(
  step: Step,
  get: () => Target | undefined,
  put: (t: Target | undefined, opts: { typing?: string; full?: boolean }) => void,
  item: string | undefined,
  optional: boolean,
  key: string,
): HTMLElement {
  const target = get();
  const choose = h("button", { class: "btn small", type: "button" }, icon(Crosshair), target ? "Choose another" : "Choose element");
  choose.onclick = () => openPicker(step, get(), (t) => put(t, { full: true }));
  if (!target) return h("div", "target", h("div", "target-body", h("div", "target-row", h("span", "help", "None"), h("div", "spacer"), choose)));

  const box = h("div", "target");
  const view = viewOf(target.source?.step);
  if (view?.screenshotId) box.append(crop(view, bboxOf(target), "zoom", 420));

  const typingKey = `${step.id}:${key}`;
  // The first element section's fields get plain ids; a second one (e.g. "Element appears") gets its own.
  const idSuffix = key === "target" ? "" : `-${key.replace(/\W+/g, "-")}`;
  const patchFp = (part: keyof Fingerprint, v: string) => {
    const t = get();
    if (!t) return;
    put({ ...t, fingerprint: withField(t.fingerprint, part, v.trim() || undefined) }, { typing: `${typingKey}.${part}` });
  };
  const description = h("input", { id: `f-Description${idSuffix}`, "aria-label": "Description", value: target.description, placeholder: "What it is, in plain words" });
  description.oninput = () => {
    const t = get();
    if (t) put({ ...t, description: description.value }, { typing: `${typingKey}.description` });
  };
  const bodyEl = h("div", "target-body", h("div", "target-row", description, choose));
  if (!view?.screenshotId) bodyEl.append(h("p", "help", target.source ? "No screenshot of this moment in the recording." : "Not an element from the recording."));

  if (item) {
    const within = h("input", { type: "checkbox", checked: target.within === item });
    within.onchange = () => {
      const t = get();
      if (!t) return;
      const { within: _, ...rest } = t;
      put(within.checked ? { ...rest, within: item } : rest, { full: true });
    };
    bodyEl.append(h("label", "switch", within, `Only inside the current ${item}`));
  }

  const locator = h("div", "fields");
  locator.append(...textField("Role", target.fingerprint.role, (v) => patchFp("role", v), { placeholder: "button, link, textbox…", idSuffix }));
  locator.append(...textField("Name", target.fingerprint.name, (v) => patchFp("name", v), { placeholder: "Its label or text", idSuffix }));
  locator.append(...textField("CSS", target.fingerprint.css, (v) => patchFp("css", v), { placeholder: "Optional selector", mono: true, idSuffix }));
  const details = h("details", "locator", h("summary", {}, "Locator", icon(ChevronDown)), locator);
  const row = h("div", "target-row", details);
  if (optional) row.append(h("div", "spacer"), h("button", { class: "btn ghost small danger", type: "button", onclick: () => put(undefined, { full: true }) }, "Remove"));
  bodyEl.append(row);
  box.append(bodyEl);
  return box;
}

function stepActions(step: Step): HTMLElement {
  const insert = h("button", { class: "btn small", type: "button" }, icon(Plus), "Insert after");
  const inLoop = step.kind === "forEach" || Boolean(locate(current.steps, step.id)?.loop);
  insert.onclick = () => openMenu(insert, inLoop, (kind) => add(kind, { after: step.id }));
  return h(
    "div",
    "panel-actions",
    insert,
    h("button", { class: "btn small", type: "button", onclick: () => move(step.id, -1) }, icon(ArrowUp), "Up"),
    h("button", { class: "btn small", type: "button", onclick: () => move(step.id, 1) }, icon(ArrowDown), "Down"),
    h("div", "spacer"),
    h("button", { class: "btn small danger", type: "button", onclick: () => remove(step.id) }, icon(Trash2), "Delete step"),
  );
}

// ---- Recording tab ----

function recordingPanel(): HTMLElement[] {
  if (!recording) {
    return [h("p", "rec-intro", "This workflow wasn't made from a recording, so there are no screenshots or page elements to choose from.")];
  }
  const excluded = new Map((shown().notes?.excludedSteps ?? []).map((x) => [x.step, x.reason]));
  const usedBy = new Map<string, string[]>();
  for (const s of allSteps(shown().steps)) {
    const ids = new Set([...(s.basedOn ?? []), ...("target" in s && s.target?.source ? [s.target.source.step] : [])]);
    for (const rid of ids) usedBy.set(rid, [...(usedBy.get(rid) ?? []), s.id]);
  }
  const order = allSteps(shown().steps).map((s) => s.id);
  const rec = recording;
  const items = [...recSteps.values()].map((step) => {
    const view = viewOf(step.id);
    const toggle = iconButton(step.noise ? Eye : EyeOff, step.noise ? "Keep this step" : "Mark as noise", async () => {
      await api(`/recordings/${rec.id}/overrides/${step.events[0]}`, { method: "PUT", body: { noise: !step.noise } });
      await loadRecording(rec.id);
      renderPanel();
    });
    const users = usedBy.get(step.id) ?? [];
    return h(
      "li",
      step.noise ? "is-noise" : "",
      view?.screenshotId ? crop(view, "target" in step ? step.target?.bbox : undefined, "thumb", 360) : h("div", "thumb none", icon(REC_ICONS[step.kind])),
      h(
        "div",
        {},
        h("div", "what", describeStep(step)),
        step.noise && h("div", "sub noise", `Likely noise: ${step.noise.reason}`),
        excluded.has(step.id) && h("div", "sub", `Left out by Claude: ${excluded.get(step.id)}`),
        users.length > 0 && h("div", "used", ...users.map((sid) => h("button", { type: "button", onclick: () => select(sid) }, `Step ${order.indexOf(sid) + 1}`))),
      ),
      toggle,
    );
  });
  return [
    h("p", "rec-intro", `What you did in “${rec.name}”. Steps marked as noise are left out the next time the recording is compiled from the side panel.`),
    h("ul", "rec", ...items),
  ];
}

// ---- Settings tab ----

function settingsPanel(): HTMLElement[] {
  const wf = shown();
  const locked = Boolean(proposal);
  const rows = h("div", "tab-rows", h("span", "head", "Tab"), h("span", "head", "Starts at"), h("span"));
  for (const [role, tab] of Object.entries(wf.tabs)) {
    const roleInput = h("input", { value: role, disabled: locked, "aria-label": "Tab name" });
    roleInput.onchange = () => {
      const to = roleInput.value.trim();
      if (!to || to === role || to in current.tabs) return void (roleInput.value = role);
      change(renameTab(current, role, to), { full: true });
    };
    const url = h("input", { value: tab.startUrl ?? "", class: "mono", placeholder: "Opened by a step", disabled: locked, "aria-label": `${role} start URL` });
    url.oninput = () => {
      const v = url.value.trim();
      change({ ...current, tabs: { ...current.tabs, [role]: v ? { startUrl: v } : {} } }, { typing: `tab:${role}` });
    };
    const removeTab = iconButton(X, `Remove the ${role} tab`, () => {
      const { [role]: _, ...rest } = current.tabs;
      change({ ...current, tabs: rest }, { full: true });
    });
    removeTab.disabled = locked || Object.keys(wf.tabs).length < 2;
    rows.append(roleInput, url, removeTab);
  }
  const addTab = h("button", { class: "btn small", type: "button", disabled: locked }, icon(Plus), "Add tab");
  addTab.onclick = () => {
    let n = Object.keys(current.tabs).length + 1;
    while (`tab${n}` in current.tabs) n++;
    change({ ...current, tabs: { ...current.tabs, [`tab${n}`]: {} } }, { full: true });
  };
  const popups = h("input", { type: "checkbox", checked: Boolean(wf.closePopups), disabled: locked });
  popups.onchange = () => {
    const { closePopups: _, ...rest } = current;
    change(popups.checked ? { ...rest, closePopups: true } : rest, { full: true });
  };
  return [
    section("Tabs", h("p", { class: "help", style: "margin-bottom:10px" }, "Each tab the workflow uses, and where it opens if it isn't open yet."), rows, h("div", { style: "margin-top:8px" }, addTab)),
    section("While running", h("label", "switch", popups, "Close tabs that pages open on other sites, like ads")),
  ];
}

// ---- Element picker ----

/** Opens the element picker on a recorded page state; calls onPick with the chosen element as a target. */
function openPicker(step: Step, previous: Target | undefined, onPick: (t: Target) => void) {
  const states = [...recSteps.values()].filter((s) => viewOf(s.id)?.inventory?.length);
  const dialog = $("picker");
  if (!states.length) {
    toast("The recording has no page elements to choose from. Fill in the locator by hand.");
    return;
  }
  const opener = document.activeElement as HTMLElement | null;
  const preferred = previous?.source?.step ?? sourceOf(step);
  let stateId = states.find((s) => s.id === preferred)?.id ?? states[0].id;
  const item = locate(current.steps, step.id)?.loop?.as;
  const close = () => {
    dialog.hidden = true;
    dialog.replaceChildren();
    document.removeEventListener("keydown", onKey, true);
    opener?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  const draw = () => {
    const view = viewOf(stateId)!;
    const inventory = view.inventory ?? [];
    const pick = (i: number) => {
      // Per item when the step's current element is, or when choosing a first one inside a loop.
      const within = previous && previous.description !== "element" ? (previous.within ? item : undefined) : item;
      onPick(pickedTarget(inventory[i], { step: stateId, inventoryIndex: i }, previous, within));
      close();
    };
    const stateSelect = h("select", { "aria-label": "Page state" }, ...states.map((s) => h("option", { value: s.id, selected: s.id === stateId }, `${s.id}: ${describeStep(s)}`)));
    stateSelect.onchange = () => ((stateId = stateSelect.value), draw());
    const search = h("input", { type: "search", placeholder: "Filter elements", "aria-label": "Filter elements" });
    const list = h("ul");
    const rows: HTMLLIElement[] = [];
    const boxes = new Map<number, HTMLElement>();
    const hot = (i: number, on: boolean) => {
      rows[i]?.classList.toggle("hot", on);
      boxes.get(i)?.classList.toggle("hot", on);
      if (on) rows[i]?.scrollIntoView({ block: "nearest" });
    };
    inventory.forEach((entry, i) => {
      const fp = entry.fingerprint;
      const isCurrent = previous?.source?.step === stateId && previous.source.inventoryIndex === i;
      const row = h("li", { class: isCurrent ? "current" : "", onclick: () => pick(i), onmouseenter: () => hot(i, true), onmouseleave: () => hot(i, false) },
        h("span", "role", fp.role ?? entry.tag), h("span", "label", fp.name ?? fp.href ?? fp.css ?? ""));
      rows[i] = row;
      list.append(row);
    });
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach((row) => (row.hidden = Boolean(q) && !row.textContent!.toLowerCase().includes(q)));
    };
    search.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const first = rows.findIndex((r) => !r.hidden);
      if (first !== -1) pick(first);
    };
    const pane = h("div", "view");
    if (view.screenshotId) {
      pane.append(screenshot(view, inventory.flatMap((entry, i) => (entry.fingerprint.bbox ? [{
        bbox: entry.fingerprint.bbox, title: `${entry.fingerprint.role ?? entry.tag} ${entry.fingerprint.name ?? ""}`,
        onClick: () => pick(i), onHover: (on: boolean) => hot(i, on), placed: (b: HTMLElement) => boxes.set(i, b),
      }] : []))));
    } else {
      pane.append(h("p", "empty", "No screenshot of this moment. Choose from the list."));
    }
    dialog.replaceChildren(
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": "Choose an element" },
        h("header", {}, h("strong", {}, "Choose an element"), stateSelect, h("span", "count", `${inventory.length} elements`), h("div", "spacer"),
          iconButton(X, "Close", close, "icon-btn")),
        h("div", "panes", pane, h("div", "side", h("label", "search", icon(Search), search), list)),
      ),
    );
    dialog.onclick = (e) => {
      if (e.target === dialog) close();
    };
    search.focus();
  };
  dialog.hidden = false;
  draw();
}

// ---- Actions ----

async function save(): Promise<boolean> {
  try {
    const res = await api<{ workflow: Workflow; problems: WorkflowProblem[] }>(`/workflows/${workflowId}`, { method: "PUT", body: current });
    saved = res.workflow;
    current = structuredClone(res.workflow);
    typing = undefined;
    render();
    toast(res.problems.length ? `Saved with ${res.problems.length} problem${res.problems.length === 1 ? "" : "s"}` : "Saved");
    return true;
  } catch (err) {
    toast(`Couldn't save: ${(err as Error).message}`, { bad: true });
    return false;
  }
}

async function run(options: object) {
  if (dirty() && !(await save())) return;
  try {
    await api(`/workflows/${workflowId}/runs`, { method: "POST", body: options });
    toast("Run started. Follow it in the side panel.");
  } catch (err) {
    toast(`Couldn't start the run: ${(err as Error).message}`, { bad: true });
  }
}

async function ask() {
  const textarea = $<HTMLTextAreaElement>("request");
  const request = textarea.value.trim();
  if (!request) return textarea.focus();
  // Claude starts from the stored version, so edits are saved first.
  if (dirty() && !(await save())) return;
  const status = $("ask-status");
  const button = $<HTMLButtonElement>("ask-go");
  button.disabled = true;
  textarea.disabled = true;
  status.className = "ask-status working";
  status.textContent = "Claude is updating the workflow. This can take a minute.";
  try {
    const res = await api<{ proposalId: string; workflow: Workflow }>(`/workflows/${workflowId}/propose`, { method: "POST", body: { request } });
    proposal = { id: res.proposalId, workflow: res.workflow, diff: diffSteps(current.steps, res.workflow.steps) };
    status.textContent = "";
    render();
  } catch (err) {
    status.className = "ask-status";
    status.textContent = `Claude couldn't change it: ${(err as Error).message}`;
  } finally {
    button.disabled = false;
    textarea.disabled = false;
  }
}

async function acceptProposal() {
  if (!proposal) return;
  try {
    const wf = await api<Workflow>(`/workflows/${workflowId}/proposals/${proposal.id}/accept`, { method: "POST" });
    past.push(current);
    future = [];
    saved = wf;
    current = structuredClone(wf);
    proposal = undefined;
    $<HTMLTextAreaElement>("request").value = "";
    autosize();
    if (selected && !locate(current.steps, selected)) selected = undefined;
    render();
    toast("Changes accepted and saved");
  } catch (err) {
    toast(`Couldn't accept: ${(err as Error).message}`, { bad: true });
  }
}

async function discardProposal() {
  if (!proposal) return;
  await api(`/workflows/${workflowId}/proposals/${proposal.id}`, { method: "DELETE" }).catch(() => {});
  proposal = undefined;
  if (selected && !locate(current.steps, selected)) selected = undefined;
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
    document.body.textContent = `Couldn't load the workflow: ${(err as Error).message}. Is the server running? Start it with pnpm dev:server.`;
    return;
  }
  current = structuredClone(saved);
  if (saved.recordingId) await loadRecording(saved.recordingId).catch(() => (recording = undefined));
  panelTab = recording ? "recording" : "settings";
  document.title = `${saved.name} · Workflow editor`;
  render();
}

// ---- Wiring ----

function autosize() {
  const t = $<HTMLTextAreaElement>("request");
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight}px`;
}

$("undo").append(icon(Undo2));
$("redo").append(icon(Redo2));
$("composer").querySelector(".composer-icon")!.append(icon(Sparkles));
$("proposal").querySelector(".proposal-icon")!.append(icon(Sparkles));

$<HTMLInputElement>("name").oninput = (e) => change({ ...current, name: (e.target as HTMLInputElement).value }, { typing: "name" });
$("save").onclick = () => save();
$("undo").onclick = undo;
$("redo").onclick = redo;
setUpTheme($("theme"));
$("problems-pill").onclick = () => {
  const first = checkWorkflow(current).find((p) => p.stepId);
  if (first?.stepId) return select(first.stepId);
  panelTab = "settings";
  renderPanel();
};
$("dry").onclick = () => run({ limit: 1 });
$("run").onclick = () => run({});
$("composer").onsubmit = (e) => {
  e.preventDefault();
  ask();
};
$<HTMLTextAreaElement>("request").oninput = autosize;
$<HTMLTextAreaElement>("request").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ask();
  }
};
$("proposal-accept").onclick = acceptProposal;
$("proposal-discard").onclick = discardProposal;
for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
  b.onclick = () => {
    panelTab = b.dataset.tab as PanelTab;
    renderPanel();
  };
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (dirty() && !proposal) save();
    return;
  }
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!proposal) $("request").focus();
    return;
  }
  if (!$("picker").hidden || !$("menu").hidden || isTyping(e.target)) return;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  const order = allSteps(shown().steps).map((s) => s.id);
  const i = selected ? order.indexOf(selected) : -1;
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey && selected && !proposal) {
    e.preventDefault();
    move(selected, e.key === "ArrowUp" ? -1 : 1);
  } else if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    select(order[Math.min(i + 1, order.length - 1)]);
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    select(order[Math.max(i - 1, 0)]);
  } else if ((e.key === "Backspace" || e.key === "Delete") && selected && !proposal) {
    e.preventDefault();
    remove(selected);
  } else if (e.key === "Escape" && selected) {
    select(undefined);
  }
});
addEventListener("beforeunload", (e) => {
  if (current && dirty()) e.preventDefault();
});

load();
