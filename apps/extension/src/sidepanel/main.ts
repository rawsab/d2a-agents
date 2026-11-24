import { type RecordedEvent, type Recording, type SemanticStep, SERVER_PORT, describeStep, mergeEvents } from "@d2a/shared";

const API = `http://127.0.0.1:${SERVER_PORT}`;
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
$("refresh").onclick = loadLibrary;
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
setInterval(refreshStatus, 2000);
