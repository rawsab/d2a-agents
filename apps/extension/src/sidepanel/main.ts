import {
  type RecordedEvent,
  type Recording,
  type RunSnapshot,
  type SemanticStep,
  type Step,
  type Workflow,
  describeEffect,
  describeWorkflowStep,
  describeStep,
  mergeEvents,
} from "@d2a/shared";
import { API_URL as API } from "../config.js";
type RecordingState = { id: string; name: string } | null;
type Status = { connected: boolean; recording: RecordingState };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let status: Status = { connected: false, recording: null };
let liveEvents: RecordedEvent[] = [];
let openRecordingId: string | undefined;

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Called with the step's first event index and the new decision (true = noise, false = keep). */
type OnDecide = (eventIndex: number, noise: boolean) => void;

function renderSteps(list: HTMLOListElement, steps: SemanticStep[], events: RecordedEvent[], onDecide?: OnDecide) {
  list.replaceChildren();
  if (steps.length === 0) list.append(el("li", "empty", "No steps yet — interact with a page."));
  for (const step of steps) {
    const li = el("li", step.noise ? "noise" : undefined);
    const body = el("div");
    body.append(el("div", "desc", describeStep(step)));
    if (step.noise) body.append(el("div", "why", `Likely noise: ${step.noise.reason}`));
    const inventory = step.events.map((i) => events[i]?.inventory).find(Boolean);
    const meta = [
      host(step.url),
      step.effect ? describeEffect(step.effect) : "",
      inventory ? `${inventory.length} elements available` : "",
      step.keptByUser ? "kept by you" : "",
    ].filter(Boolean).join(" · ");
    body.append(el("div", "meta", meta));
    if (onDecide) {
      const toggle = el("button", "ghost toggle", step.noise ? "Keep step" : "Mark as noise");
      toggle.onclick = () => onDecide(step.events[0], !step.noise);
      body.append(toggle);
    }
    const shot = step.events.map((i) => events[i]?.screenshotId).find(Boolean);
    if (shot) {
      const img = el("img");
      img.src = `${API}/screenshots/${shot}`;
      img.alt = "";
      img.loading = "lazy";
      img.onclick = () => img.classList.toggle("big");
      body.append(img);
    }
    li.append(body);
    list.append(li);
  }
}

function renderStatus() {
  const conn = $("conn");
  conn.classList.toggle("on", status.connected);
  conn.querySelector(".label")!.textContent = status.connected ? "Server connected" : "Server offline";

  const toggle = $<HTMLButtonElement>("toggle");
  const recording = Boolean(status.recording);
  toggle.textContent = recording ? "Stop" : "Record";
  toggle.classList.toggle("stop", recording);
  $<HTMLInputElement>("name").disabled = recording;
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

async function loadLibrary() {
  const list = $<HTMLUListElement>("recordings");
  list.replaceChildren();
  let rows: { id: string; name: string; createdAt: number; eventCount: number }[];
  try {
    rows = await (await fetch(`${API}/recordings`)).json();
  } catch {
    list.append(el("li", "empty", "Start the server: pnpm dev:server"));
    return;
  }
  if (rows.length === 0) list.append(el("li", "empty", "No recordings yet."));
  for (const r of rows) {
    const li = el("li");
    li.append(el("div", undefined, r.name), el("div", "meta", `${new Date(r.createdAt).toLocaleString()} · ${r.eventCount} events`));
    li.onclick = () => openRecording(r.id);
    list.append(li);
  }
}

type CompileResponse = {
  workflow: Workflow;
  preview: { lists: { name: string; count: number; sample: Record<string, unknown>[] }[]; error?: string } | null;
  /** Undefined when showing a saved workflow rather than a fresh compile. */
  checkedOnLivePage?: boolean;
  error?: string;
};

function renderPlan(list: HTMLOListElement, steps: Step[]) {
  list.replaceChildren();
  for (const step of steps) {
    const li = el("li", undefined, describeWorkflowStep(step));
    if (step.kind === "forEach") {
      const body = el("ol");
      renderPlan(body, step.body);
      li.append(body);
    }
    list.append(li);
  }
}

function renderCompiled(res: CompileResponse) {
  const { workflow, preview } = res;
  const notes = workflow.notes;
  $("compiled").hidden = false;
  $("compiled-summary").textContent = notes?.summary ?? workflow.name;
  renderPlan($<HTMLOListElement>("compiled-steps"), workflow.steps);
  const list = $<HTMLUListElement>("compiled-notes");
  list.replaceChildren();
  const note = (cls: string, text: string) => list.append(el("li", cls, text));
  for (const p of notes?.problems ?? []) note("problem", `Problem: ${p}`);
  if (workflow.closePopups) note("", "Closes tabs that pages open on other sites (ads) while it runs.");
  for (const a of notes?.assumptions ?? []) note("", `Assumed: ${a}`);
  for (const x of notes?.excludedSteps ?? []) note("muted", `Left out ${x.step}: ${x.reason}`);
  for (const l of preview?.lists ?? []) {
    const first = l.sample[0];
    const example = first ? Object.entries(first).find(([k, v]) => !k.startsWith("_") && v)?.[1] : undefined;
    note("", `Found ${l.count} ${l.name} on the live page${example ? `, e.g. "${String(example).slice(0, 60)}"` : ""}`);
  }
  if (res.checkedOnLivePage === false) note("muted", "Not checked on the live page (browser busy or disconnected).");
  renderFollowup(workflow);
  $<HTMLButtonElement>("compiled-dry").onclick = () => startRun(workflow.id, { limit: 1 });
  $<HTMLButtonElement>("compiled-run").onclick = () => startRun(workflow.id, {});
}

/** Answer boxes for Claude's questions, plus a free-form change request. */
function renderFollowup(workflow: Workflow) {
  const questions = workflow.notes?.questions ?? [];
  const box = $("compiled-questions");
  box.replaceChildren();
  const inputs = questions.map((q, i) => {
    const wrap = el("div", "question");
    const label = el("label", undefined, q);
    const input = el("textarea");
    input.rows = 2;
    input.id = `answer-${i}`;
    label.htmlFor = input.id;
    input.placeholder = "Your answer";
    wrap.append(label, input);
    box.append(wrap);
    return input;
  });
  const request = $<HTMLTextAreaElement>("change-request");
  request.value = "";
  $("refine-status").textContent = "";
  $<HTMLButtonElement>("refine").onclick = async () => {
    const answers = questions.map((question, i) => ({ question, answer: inputs[i].value.trim() })).filter((a) => a.answer);
    if (!answers.length && !request.value.trim()) return (inputs[0] ?? request).focus();
    const button = $<HTMLButtonElement>("refine");
    const status = $("refine-status");
    button.disabled = true;
    status.textContent = "Claude is updating the automation…";
    try {
      const res = await fetch(`${API}/workflows/${workflow.id}/refine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers, request: request.value.trim() }),
      });
      const body = (await res.json()) as CompileResponse;
      if (!res.ok) {
        status.textContent = `Could not update: ${body.error}`;
        return;
      }
      renderCompiled(body);
      $("refine-status").textContent = "Updated.";
      loadWorkflows();
    } catch (err) {
      status.textContent = `Could not reach the server: ${(err as Error).message}`;
    } finally {
      button.disabled = false;
    }
  };
}

/** Opens a saved workflow's review, under the recording it was compiled from. */
async function openWorkflow(id: string) {
  const workflow = (await (await fetch(`${API}/workflows/${id}`)).json()) as Workflow;
  if (!workflow.recordingId) return;
  await openRecording(workflow.recordingId);
  $<HTMLTextAreaElement>("instruction").value = workflow.instruction ?? "";
  renderCompiled({ workflow, preview: null });
}

async function compileRecording(id: string) {
  const instruction = $<HTMLTextAreaElement>("instruction").value.trim();
  if (!instruction) return $<HTMLTextAreaElement>("instruction").focus();
  const button = $<HTMLButtonElement>("compile");
  const status = $("compile-status");
  button.disabled = true;
  $("compiled").hidden = true;
  status.textContent = "Claude is building the automation; this can take a minute or two…";
  try {
    const res = await fetch(`${API}/recordings/${id}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction }),
    });
    const body = (await res.json()) as CompileResponse;
    if (!res.ok) {
      status.textContent = `Could not automate: ${body.error}`;
      return;
    }
    status.textContent = "";
    renderCompiled(body);
    loadWorkflows();
  } catch (err) {
    status.textContent = `Could not reach the server: ${(err as Error).message}`;
  } finally {
    button.disabled = false;
  }
}

async function openRecording(id: string) {
  const rec = (await (await fetch(`${API}/recordings/${id}`)).json()) as Recording;
  if (openRecordingId !== id) {
    $("compiled").hidden = true;
    $("compile-status").textContent = "";
  }
  openRecordingId = id;
  $("detail-name").textContent = rec.name;
  $<HTMLButtonElement>("compile").onclick = () => compileRecording(id);
  const decide: OnDecide = async (eventIndex, noise) => {
    await fetch(`${API}/recordings/${id}/overrides/${eventIndex}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noise }),
    });
    openRecording(id);
  };
  renderSteps($<HTMLOListElement>("detail-steps"), mergeEvents(rec.events, rec.overrides), rec.events, decide);
  $("library").hidden = true;
  $("detail").hidden = false;
}

function closeDetail() {
  openRecordingId = undefined;
  $("detail").hidden = true;
  $("library").hidden = false;
  loadLibrary();
}

const ITEM_ICON: Record<string, string> = { ok: "✓", failed: "✗", running: "▸", pending: "·" };
let runId: string | undefined;

async function loadWorkflows() {
  const list = $<HTMLUListElement>("workflow-list");
  let rows: { id: string; name: string; createdAt: number }[];
  try {
    rows = await (await fetch(`${API}/workflows`)).json();
  } catch {
    return; // loadLibrary already shows the "start the server" hint
  }
  list.replaceChildren();
  if (rows.length === 0) list.append(el("li", "empty", "No workflows yet. Try: pnpm fixtures:workflow"));
  for (const wf of rows) {
    const li = el("li");
    const actions = el("div", "actions");
    const dry = el("button", undefined, "Dry run (1 item)");
    const full = el("button", "primary", "Run all");
    dry.onclick = () => startRun(wf.id, { limit: 1 });
    full.onclick = () => startRun(wf.id, {});
    actions.append(dry, full);
    const name = el("div", "name", wf.name);
    name.title = "Review and update";
    name.onclick = () => openWorkflow(wf.id);
    li.append(name, actions);
    list.append(li);
  }
}

async function startRun(workflowId: string, options: object) {
  const res = await fetch(`${API}/workflows/${workflowId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  const body = await res.json();
  if (!res.ok) return alert(`Could not start: ${body.error}`);
  runId = body.id;
  renderRun(body);
}

function renderRun(run: RunSnapshot | null) {
  $("run").hidden = !run;
  if (!run) return;
  const finished = Boolean(run.finishedAt);
  const done = run.items.filter((i) => i.status === "ok" || i.status === "failed").length;
  $("run-title").textContent = run.workflowName;
  $("run-status").textContent =
    `${run.status}${run.items.length ? ` · ${done}/${run.items.length} items` : ""}${run.error ? ` · ${run.error}` : ""}`;
  const pause = $<HTMLButtonElement>("run-pause");
  pause.textContent = run.status === "paused" ? "Resume" : "Pause";
  pause.hidden = finished;
  $<HTMLButtonElement>("run-stop").textContent = finished ? "Close" : "Stop";

  const items = $<HTMLOListElement>("run-items");
  items.replaceChildren();
  for (const item of run.items) {
    const li = el("li");
    li.append(el("span", item.status, ITEM_ICON[item.status]), el("span", undefined, item.label));
    if (item.error) li.append(el("span", "err", item.error));
    items.append(li);
  }
  const log = $<HTMLOListElement>("run-log");
  log.replaceChildren(...run.log.slice(-100).map((l) => el("li", l.level, `${new Date(l.ts).toLocaleTimeString()} ${l.message}`)));
}

async function pollRun() {
  try {
    const current = (await (await fetch(`${API}/runs/current`)).json()) as RunSnapshot | null;
    if (current) runId = current.id;
    if (!runId) return renderRun(null);
    renderRun(current ?? ((await (await fetch(`${API}/runs/${runId}`)).json()) as RunSnapshot));
  } catch {
    // server offline; status line already says so
  }
}

$("run-pause").onclick = async () => {
  if (!runId) return;
  const paused = $("run-pause").textContent === "Resume";
  await fetch(`${API}/runs/${runId}/${paused ? "resume" : "pause"}`, { method: "POST" });
  pollRun();
};
$("run-stop").onclick = async () => {
  if (!runId) return;
  if ($("run-stop").textContent === "Close") {
    runId = undefined;
    return renderRun(null);
  }
  await fetch(`${API}/runs/${runId}/stop`, { method: "POST" });
  pollRun();
};

$("toggle").onclick = async () => {
  if (status.recording) {
    await chrome.runtime.sendMessage({ type: "stopRecording" });
    await refreshStatus();
    // Give the server a moment to persist the last events.
    setTimeout(loadLibrary, 300);
  } else {
    liveEvents = [];
    renderSteps($<HTMLOListElement>("live-steps"), [], []);
    await chrome.runtime.sendMessage({ type: "startRecording", name: $<HTMLInputElement>("name").value.trim() });
    $<HTMLInputElement>("name").value = "";
    await refreshStatus();
  }
};
$("refresh").onclick = () => {
  loadLibrary();
  loadWorkflows();
};
$("back").onclick = closeDetail;
$("delete").onclick = async () => {
  if (!openRecordingId || !confirm("Delete this recording?")) return;
  await fetch(`${API}/recordings/${openRecordingId}`, { method: "DELETE" });
  closeDetail();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "recorder/event" || msg.recordingId !== status.recording?.id) return;
  liveEvents.push(msg.data as RecordedEvent);
  renderSteps($<HTMLOListElement>("live-steps"), mergeEvents(liveEvents), liveEvents);
});

refreshStatus();
loadLibrary();
loadWorkflows();
pollRun();
setInterval(refreshStatus, 2000);
setInterval(pollRun, 1000);
