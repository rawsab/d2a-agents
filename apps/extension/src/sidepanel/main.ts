import {
  type RecordedEvent,
  type Recording,
  type RunSnapshot,
  type SemanticStep,
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

function renderSteps(list: HTMLOListElement, steps: SemanticStep[], events: RecordedEvent[]) {
  list.replaceChildren();
  if (steps.length === 0) list.append(el("li", "empty", "No steps yet — interact with a page."));
  for (const step of steps) {
    const li = el("li");
    const body = el("div");
    body.append(el("div", "desc", describeStep(step)));
    const inventory = step.events.map((i) => events[i]?.inventory).find(Boolean);
    const meta = [host(step.url), inventory ? `${inventory.length} elements available` : ""].filter(Boolean).join(" · ");
    body.append(el("div", "meta", meta));
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

async function openRecording(id: string) {
  const rec = (await (await fetch(`${API}/recordings/${id}`)).json()) as Recording;
  openRecordingId = id;
  $("detail-name").textContent = rec.name;
  renderSteps($<HTMLOListElement>("detail-steps"), mergeEvents(rec.events), rec.events);
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
    li.append(el("div", undefined, wf.name), actions);
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
