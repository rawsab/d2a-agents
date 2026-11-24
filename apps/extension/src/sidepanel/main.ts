import {
  type RecordedEvent,
  type Recording,
  type RunSnapshot,
  type SemanticStep,
  type Step,
  type Workflow,
  describeEffect,
  describeStep,
  describeWorkflowStep,
  mergeEvents,
} from "@d2a/shared";
import {
  AppWindow,
  ArrowLeft,
  ArrowLeftRight,
  Bandage,
  Check,
  Circle,
  CircleCheck,
  CircleX,
  Clipboard,
  Eye,
  EyeOff,
  FlaskConical,
  Globe,
  Hourglass,
  Image as ImageIcon,
  type IconNode,
  Keyboard,
  ListTree,
  LoaderCircle,
  MousePointerClick,
  PanelTopClose,
  Pause,
  PenLine,
  Play,
  RefreshCw,
  Repeat,
  ScanText,
  ShieldCheck,
  Sparkles,
  Square,
  TextCursorInput,
  Trash2,
  X,
} from "lucide";
import { API_URL as API } from "../config.js";
import { $, h, icon, iconButton, setUpTheme, toast } from "../ui/dom.js";

type RecordingState = { id: string; name: string } | null;
type Status = { connected: boolean; recording: RecordingState };

let status: Status = { connected: false, recording: null };
let liveEvents: RecordedEvent[] = [];
let openRecordingId: string | undefined;

const RECORDED_ICONS: Record<SemanticStep["kind"], IconNode> = {
  openTab: AppWindow,
  switchTab: ArrowLeftRight,
  navigate: Globe,
  click: MousePointerClick,
  fill: TextCursorInput,
  press: Keyboard,
  copy: Clipboard,
  submit: MousePointerClick,
};

const STEP_ICONS: Record<Step["kind"], IconNode> = {
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

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

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

// ---- Recorded steps ----

/** Called with the step's first event index and the new decision (true = noise, false = keep). */
type OnDecide = (eventIndex: number, noise: boolean) => void;

function renderSteps(list: HTMLOListElement, steps: SemanticStep[], events: RecordedEvent[], onDecide?: OnDecide) {
  if (steps.length === 0) return void list.replaceChildren(h("li", "empty", "Nothing yet. Use the page as you normally would."));
  list.replaceChildren(
    ...steps.map((step) => {
      const meta = [host(step.url), step.effect ? describeEffect(step.effect) : "", step.keptByUser ? "kept by you" : ""].filter(Boolean).join(", ");
      const shot = step.events.map((i) => events[i]?.screenshotId).find(Boolean);
      const side = h("div", "side");
      const li = h(
        "li",
        step.noise ? "noise" : "",
        h("span", "node", icon(RECORDED_ICONS[step.kind])),
        h("div", {}, h("div", "desc", describeStep(step)), h("div", "meta", meta), step.noise && h("div", "why", `Likely noise: ${step.noise.reason}`)),
        side,
      );
      if (shot) {
        let full: HTMLImageElement | undefined;
        const show = iconButton(ImageIcon, "Show screenshot", () => toggle());
        const toggle = () => {
          if (full) full.remove();
          full = full ? undefined : h("img", { class: "full", src: `${API}/screenshots/${shot}`, alt: "Screenshot", onclick: () => toggle() });
          if (full) li.append(full);
          show.setAttribute("aria-pressed", String(Boolean(full)));
        };
        side.append(show);
      }
      if (onDecide) {
        side.append(iconButton(step.noise ? Eye : EyeOff, step.noise ? "Keep this step" : "Mark as noise", () => onDecide(step.events[0], !step.noise)));
      }
      return li;
    }),
  );
}

// ---- Status and recording ----

function renderStatus() {
  const conn = $("conn");
  conn.classList.toggle("on", status.connected);
  conn.querySelector(".label")!.textContent = status.connected ? "Connected" : "Server offline";

  const toggle = $<HTMLButtonElement>("toggle");
  const recording = Boolean(status.recording);
  toggle.querySelector(".label")!.textContent = recording ? "Stop" : "Record";
  toggle.classList.toggle("stop", recording);
  $<HTMLInputElement>("name").disabled = recording;
  $<HTMLInputElement>("name").placeholder = recording ? "Recording…" : "Name a new recording";
  $("live").hidden = !recording;
  $("live-name").textContent = status.recording?.name ?? "";
}

async function refreshStatus() {
  const res = (await chrome.runtime.sendMessage({ type: "getStatus" }).catch(() => undefined)) as Status | undefined;
  const wasRecording = status.recording?.id;
  status = res ?? { connected: false, recording: null };
  if (status.recording?.id !== wasRecording) liveEvents = [];
  renderStatus();
}

function renderLive() {
  const steps = mergeEvents(liveEvents);
  $("live-count").textContent = steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "";
  renderSteps($<HTMLOListElement>("live-steps"), steps, liveEvents);
}

// ---- Libraries ----

const offline = () => h("li", "empty", "Start the server to see your recordings: ", h("code", {}, "pnpm dev:server"));

async function loadLibrary() {
  const list = $<HTMLUListElement>("recordings");
  let rows: { id: string; name: string; createdAt: number; eventCount: number }[];
  try {
    rows = await api("/recordings");
  } catch {
    return void list.replaceChildren(offline());
  }
  if (rows.length === 0) return void list.replaceChildren(h("li", "empty", "No recordings yet. Name one above and press Record."));
  list.replaceChildren(
    ...rows.map((r) =>
      h("li", { onclick: () => openRecording(r.id), title: "Open" },
        h("div", {}, h("div", "name", r.name), h("div", "meta", `${timeAgo(r.createdAt)}, ${r.eventCount} events`))),
    ),
  );
}

async function loadWorkflows() {
  const list = $<HTMLUListElement>("workflow-list");
  let rows: { id: string; name: string; createdAt: number }[];
  try {
    rows = await api("/workflows");
  } catch {
    return void list.replaceChildren(offline());
  }
  if (rows.length === 0) return void list.replaceChildren(h("li", "empty", "No workflows yet. Open a recording and choose Automate."));
  list.replaceChildren(
    ...rows.map((wf) => {
      const stop = (fn: () => void) => (e: Event) => (e.stopPropagation(), fn());
      return h(
        "li",
        { onclick: () => openWorkflow(wf.id), title: "Review" },
        h("div", {}, h("div", "name", wf.name), h("div", "meta", timeAgo(wf.createdAt))),
        h("div", "actions",
          iconButton(PenLine, "Open in editor", stop(() => openEditor(wf.id))),
          iconButton(FlaskConical, "Test on 1 item", stop(() => startRun(wf.id, { limit: 1 }))),
          h("button", { class: "btn small", type: "button", onclick: stop(() => startRun(wf.id, {})) }, icon(Play), "Run"),
        ),
      );
    }),
  );
}

// ---- Recording detail and compiling ----

type CompileResponse = {
  workflow: Workflow;
  preview: { lists: { name: string; count: number; sample: Record<string, unknown>[] }[]; error?: string } | null;
  /** Undefined when showing a saved workflow rather than a fresh compile. */
  checkedOnLivePage?: boolean;
  error?: string;
};

function plan(steps: Step[]): HTMLElement[] {
  return steps.map((step) =>
    h("li", {}, icon(STEP_ICONS[step.kind]), h("span", {}, capitalize(describeWorkflowStep(step))), step.kind === "forEach" && h("ol", {}, ...plan(step.body))),
  );
}

function renderCompiled(res: CompileResponse) {
  const { workflow, preview } = res;
  const notes = workflow.notes;
  $("compiled").hidden = false;
  $("compiled-name").textContent = workflow.name;
  $("compiled-summary").textContent = notes?.summary ?? "";
  $("compiled-steps").replaceChildren(...plan(workflow.steps));
  const items: HTMLElement[] = [];
  const note = (cls: string, text: string) => items.push(h("li", cls, text));
  for (const p of notes?.problems ?? []) note("problem", p);
  for (const l of preview?.lists ?? []) {
    const first = l.sample[0];
    const example = first ? Object.entries(first).find(([k, v]) => !k.startsWith("_") && v)?.[1] : undefined;
    note("", `Found ${l.count} ${l.name} on the live page${example ? `, like “${String(example).slice(0, 60)}”` : ""}`);
  }
  if (res.checkedOnLivePage === false) note("muted", "Not checked on the live page; the browser was busy or disconnected.");
  if (workflow.closePopups) note("", "Closes tabs that pages open on other sites, like ads, while it runs.");
  for (const a of notes?.assumptions ?? []) note("", a);
  for (const x of notes?.excludedSteps ?? []) note("muted", `Left out ${x.step}: ${x.reason}`);
  $("compiled-notes").replaceChildren(...items);
  renderFollowup(workflow);
  $<HTMLButtonElement>("compiled-edit").onclick = () => openEditor(workflow.id);
  $<HTMLButtonElement>("compiled-dry").onclick = () => startRun(workflow.id, { limit: 1 });
  $<HTMLButtonElement>("compiled-run").onclick = () => startRun(workflow.id, {});
}

function working(el: HTMLElement, text: string) {
  el.className = "ask-status working";
  el.textContent = text;
}
function done(el: HTMLElement, text = "") {
  el.className = "ask-status";
  el.textContent = text;
}

/** Answer boxes for Claude's questions, plus a free-form change request. */
function renderFollowup(workflow: Workflow) {
  const questions = workflow.notes?.questions ?? [];
  const inputs = questions.map((q, i) => h("textarea", { id: `answer-${i}`, rows: 2, placeholder: "Your answer" }));
  $("compiled-questions").replaceChildren(
    ...questions.map((q, i) => h("div", "question", h("label", { htmlFor: `answer-${i}` }, q), inputs[i])),
  );
  const request = $<HTMLTextAreaElement>("change-request");
  request.value = "";
  done($("refine-status"));
  $<HTMLButtonElement>("refine").onclick = async () => {
    const answers = questions.map((question, i) => ({ question, answer: inputs[i].value.trim() })).filter((a) => a.answer);
    if (!answers.length && !request.value.trim()) return (inputs[0] ?? request).focus();
    const button = $<HTMLButtonElement>("refine");
    const statusEl = $("refine-status");
    button.disabled = true;
    working(statusEl, "Claude is updating the workflow…");
    try {
      const body = await api<CompileResponse>(`/workflows/${workflow.id}/refine`, { method: "POST", body: { answers, request: request.value.trim() } });
      renderCompiled(body);
      done($("refine-status"), "Updated.");
      loadWorkflows();
    } catch (err) {
      done(statusEl, `Couldn't update: ${(err as Error).message}`);
    } finally {
      button.disabled = false;
    }
  };
}

/** Opens a saved workflow's review, under the recording it was compiled from; the editor otherwise. */
async function openWorkflow(id: string) {
  const workflow = await api<Workflow>(`/workflows/${id}`);
  if (!workflow.recordingId) return openEditor(id);
  await openRecording(workflow.recordingId);
  $<HTMLTextAreaElement>("instruction").value = workflow.instruction ?? "";
  renderCompiled({ workflow, preview: null });
}

async function compileRecording(id: string) {
  const instruction = $<HTMLTextAreaElement>("instruction").value.trim();
  if (!instruction) return $<HTMLTextAreaElement>("instruction").focus();
  const button = $<HTMLButtonElement>("compile");
  const statusEl = $("compile-status");
  button.disabled = true;
  $("compiled").hidden = true;
  working(statusEl, "Claude is building the workflow. This can take a minute or two.");
  try {
    const body = await api<CompileResponse>(`/recordings/${id}/compile`, { method: "POST", body: { instruction } });
    done(statusEl);
    renderCompiled(body);
    loadWorkflows();
  } catch (err) {
    done(statusEl, `Couldn't automate it: ${(err as Error).message}`);
  } finally {
    button.disabled = false;
  }
}

async function openRecording(id: string) {
  const rec = await api<Recording>(`/recordings/${id}`);
  if (openRecordingId !== id) {
    $("compiled").hidden = true;
    done($("compile-status"));
    $<HTMLTextAreaElement>("instruction").value = "";
  }
  openRecordingId = id;
  $("detail-name").textContent = rec.name;
  const steps = mergeEvents(rec.events, rec.overrides);
  const noise = steps.filter((s) => s.noise).length;
  $("detail-meta").textContent = `Recorded ${timeAgo(rec.createdAt)}`;
  $("detail-count").textContent = `${steps.length} steps${noise ? `, ${noise} likely noise` : ""}`;
  $("automate").onsubmit = (e) => {
    e.preventDefault();
    compileRecording(id);
  };
  const decide: OnDecide = async (eventIndex, isNoise) => {
    await api(`/recordings/${id}/overrides/${eventIndex}`, { method: "PUT", body: { noise: isNoise } });
    openRecording(id);
  };
  renderSteps($<HTMLOListElement>("detail-steps"), steps, rec.events, decide);
  $("home").hidden = true;
  $("detail").hidden = false;
  scrollTo(0, 0);
}

function closeDetail() {
  openRecordingId = undefined;
  $("detail").hidden = true;
  $("home").hidden = false;
  loadLibrary();
  loadWorkflows();
}

// ---- Runs ----

let runId: string | undefined;
let shownRun: RunSnapshot | undefined;

function openEditor(workflowId: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/editor/index.html?id=${encodeURIComponent(workflowId)}`) });
}

async function startRun(workflowId: string, options: object) {
  try {
    const run = await api<RunSnapshot>(`/workflows/${workflowId}/runs`, { method: "POST", body: options });
    runId = run.id;
    renderRun(run);
    if ($("home").hidden) closeDetail();
  } catch (err) {
    toast(`Couldn't start the run: ${(err as Error).message}`, { bad: true });
  }
}

const ITEM_ICONS: Record<string, IconNode> = { ok: Check, failed: X, running: LoaderCircle, pending: Circle };
const STATUS_TEXT: Record<RunSnapshot["status"], string> = { running: "Running", paused: "Paused", stopped: "Stopped", done: "Done", failed: "Failed" };

function renderRun(run: RunSnapshot | null) {
  shownRun = run ?? undefined;
  $("run").hidden = !run;
  if (!run) return;
  const finished = Boolean(run.finishedAt);
  const settled = run.items.filter((i) => i.status === "ok" || i.status === "failed").length;
  const failed = run.items.filter((i) => i.status === "failed").length;

  const runIcon = $("run-icon");
  const state = run.status === "done" && !failed ? "done" : run.status === "failed" || failed ? "failed" : finished ? "" : "running";
  runIcon.className = `run-icon ${state}`;
  runIcon.replaceChildren(icon(state === "done" ? CircleCheck : state === "failed" ? CircleX : run.status === "paused" ? Pause : Play));
  $("run-title").textContent = run.workflowName;
  $("run-bar").style.width = run.items.length ? `${(settled / run.items.length) * 100}%` : finished ? "100%" : "0";
  const parts = [STATUS_TEXT[run.status]];
  if (run.items.length) parts.push(`${settled} of ${run.items.length} items`);
  if (failed) parts.push(`${failed} failed`);
  $("run-status").replaceChildren(parts.join(", "), run.error ? h("span", "err", `. ${run.error}`) : "");

  const pause = $<HTMLButtonElement>("run-pause");
  pause.hidden = finished;
  pause.replaceChildren(icon(run.status === "paused" ? Play : Pause));
  pause.setAttribute("aria-label", run.status === "paused" ? "Resume" : "Pause");
  pause.title = pause.getAttribute("aria-label")!;
  const stop = $<HTMLButtonElement>("run-stop");
  stop.replaceChildren(icon(finished ? X : Square));
  stop.setAttribute("aria-label", finished ? "Close" : "Stop");
  stop.title = stop.getAttribute("aria-label")!;

  // Older saved runs have no heals.
  const name = (t: { description: string; fingerprint: { name?: string; role?: string } }) => t.fingerprint.name ?? t.fingerprint.role ?? t.description;
  $("run-heals").replaceChildren(
    ...(run.heals ?? []).map((heal, i) => {
      const li = h(
        "li",
        heal.reverted ? "reverted" : "",
        icon(Bandage),
        h("span", "what", heal.reverted ? `Put back “${name(heal.from)}” for ${heal.from.description}` : `${heal.from.description} now uses “${name(heal.to)}” instead of “${name(heal.from)}”`),
        h("span", "why", heal.reason),
      );
      if (!heal.reverted) {
        const undo = h("button", { class: "btn small", type: "button", disabled: !finished, title: finished ? "Put the original element back in the workflow" : "Available when the run ends" }, "Undo");
        undo.onclick = async () => {
          try {
            await api(`/runs/${run.id}/heals/${i}/revert`, { method: "POST" });
          } catch (err) {
            toast(`Couldn't undo: ${(err as Error).message}`, { bad: true });
          }
          pollRun();
        };
        li.append(undo);
      }
      return li;
    }),
  );

  $("run-items").replaceChildren(
    ...run.items.map((item) =>
      h("li", item.status, h("span", `icon ${item.status}`, icon(ITEM_ICONS[item.status])), h("span", "label", item.label), item.error && h("span", "err", item.error)),
    ),
  );
  $("run-log").replaceChildren(
    ...run.log.slice(-100).map((l) => h("li", l.level, h("span", "time", new Date(l.ts).toLocaleTimeString([], { hour12: false })), l.message)),
  );
}

async function pollRun() {
  try {
    const current = await api<RunSnapshot | null>("/runs/current");
    if (current) runId = current.id;
    if (!runId) return renderRun(null);
    renderRun(current ?? (await api<RunSnapshot>(`/runs/${runId}`)));
  } catch {
    // Server offline; the status line already says so.
  }
}

// ---- Wiring ----

setUpTheme($("theme"));
$("refresh").append(icon(RefreshCw));
$("back").append(icon(ArrowLeft), "Back");
$("delete").append(icon(Trash2));
$("automate").querySelector(".composer-icon")!.append(icon(Sparkles));
$("compiled").querySelector(".result-icon")!.append(icon(Sparkles));

$("run-pause").onclick = async () => {
  if (!runId || !shownRun) return;
  await fetch(`${API}/runs/${runId}/${shownRun.status === "paused" ? "resume" : "pause"}`, { method: "POST" });
  pollRun();
};
$("run-stop").onclick = async () => {
  if (!runId) return;
  if (shownRun?.finishedAt) {
    runId = undefined;
    return renderRun(null);
  }
  await fetch(`${API}/runs/${runId}/stop`, { method: "POST" });
  pollRun();
};

$("record-form").onsubmit = async (e) => {
  e.preventDefault();
  if (status.recording) {
    await chrome.runtime.sendMessage({ type: "stopRecording" });
    await refreshStatus();
    // Give the server a moment to persist the last events.
    setTimeout(loadLibrary, 300);
  } else {
    liveEvents = [];
    renderLive();
    await chrome.runtime.sendMessage({ type: "startRecording", name: $<HTMLInputElement>("name").value.trim() });
    $<HTMLInputElement>("name").value = "";
    await refreshStatus();
  }
};
$("instruction").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && openRecordingId) compileRecording(openRecordingId);
};
$("refresh").onclick = () => {
  loadLibrary();
  loadWorkflows();
};
$("back").onclick = closeDetail;
$("delete").onclick = async () => {
  if (!openRecordingId || !confirm("Delete this recording? This can't be undone.")) return;
  await api(`/recordings/${openRecordingId}`, { method: "DELETE" }).catch(() => {});
  closeDetail();
  toast("Recording deleted");
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "recorder/event" || msg.recordingId !== status.recording?.id) return;
  liveEvents.push(msg.data as RecordedEvent);
  renderLive();
});

refreshStatus();
loadLibrary();
loadWorkflows();
pollRun();
setInterval(refreshStatus, 2000);
setInterval(pollRun, 1000);
