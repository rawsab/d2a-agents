import type { PageInventory, RawEvent, RecordedEvent, Viewport } from "@d2a/shared";
import type { ServerConnection } from "./connection.js";

const KEY = "recording";
const SCREENSHOT_MIN_INTERVAL_MS = 600; // Chrome allows ~2 captureVisibleTab calls per second.
/** Only user actions get a screenshot; typing, copies and effects don't need one. */
const SCREENSHOT_EVENTS = new Set(["click", "keydown", "paste", "submit"]);

export type RecordingState = { id: string; name: string } | null;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ContentEvent = DistributiveOmit<RawEvent, "tabId">;

/** Recording state lives in storage.session so it survives service-worker restarts. */
export class Recorder {
  private lastShot = 0;
  /** Events are forwarded strictly in arrival order, even though some wait for a screenshot. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private conn: ServerConnection) {
    // Content scripts read the recording flag directly.
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(console.error);
    this.listenToTabs();
  }

  async state(): Promise<RecordingState> {
    return ((await chrome.storage.session.get(KEY))[KEY] as RecordingState) ?? null;
  }

  async start(name: string): Promise<RecordingState> {
    const state = { id: crypto.randomUUID(), name: name || `Recording ${new Date().toLocaleString()}` };
    await chrome.storage.session.set({ [KEY]: state });
    this.conn.send({ type: "recordingStarted", recordingId: state.id, name: state.name });
    // Record where the user starts, so replay knows the initial page.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) this.record({ type: "tabActivated", tabId: tab.id, url: tab.url ?? "", title: tab.title, ts: Date.now() });
    return state;
  }

  async stop(): Promise<void> {
    const state = await this.state();
    await chrome.storage.session.remove(KEY);
    if (state) this.conn.send({ type: "recordingStopped", recordingId: state.id });
  }

  fromContent(event: ContentEvent, inventory: PageInventory | undefined, viewport: Viewport | undefined, sender: chrome.runtime.MessageSender) {
    const tab = sender.tab;
    if (tab?.id === undefined || sender.frameId !== 0) return;
    const raw = { ...event, tabId: tab.id } as RawEvent;
    this.enqueue(async () => {
      const screenshotId = tab.active && SCREENSHOT_EVENTS.has(event.type) ? await this.screenshot(tab.windowId) : undefined;
      await this.send(raw, inventory, screenshotId, viewport);
    });
  }

  private record(event: RawEvent) {
    this.enqueue(() => this.send(event));
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch(console.error);
  }

  private async send(event: RawEvent, inventory?: PageInventory, screenshotId?: string, viewport?: Viewport) {
    const state = await this.state();
    if (!state) return;
    const data: RecordedEvent = { event, inventory, viewport, screenshotId };
    this.conn.send({ type: "recordedEvent", recordingId: state.id, data });
    chrome.runtime.sendMessage({ type: "recorder/event", recordingId: state.id, data }).catch(() => {});
  }

  private async screenshot(windowId: number): Promise<string | undefined> {
    const state = await this.state();
    const now = Date.now();
    if (!state || now - this.lastShot < SCREENSHOT_MIN_INTERVAL_MS) return undefined;
    this.lastShot = now;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 50 });
      const id = crypto.randomUUID();
      this.conn.send({ type: "screenshot", recordingId: state.id, id, dataUrl });
      return id;
    } catch {
      return undefined; // e.g. the page navigated away mid-capture
    }
  }

  private listenToTabs() {
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id === undefined) return;
      this.record({
        type: "tabCreated", tabId: tab.id, url: tab.pendingUrl ?? tab.url ?? "", title: tab.title,
        ts: Date.now(), openerTabId: tab.openerTabId,
      });
    });
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      this.record({ type: "tabActivated", tabId, url: tab?.url ?? "", title: tab?.title, ts: Date.now() });
    });
    const onNav = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (d.frameId !== 0) return;
      this.record({
        type: "navigate", tabId: d.tabId, url: d.url, ts: d.timeStamp,
        transitionType: d.transitionType, transitionQualifiers: d.transitionQualifiers,
      });
    };
    chrome.webNavigation.onCommitted.addListener(onNav);
    // Single-page apps (e.g. YouTube) navigate with history.pushState.
    chrome.webNavigation.onHistoryStateUpdated.addListener(onNav);
  }
}
