import type { Command, CommandResults, Locator } from "@d2a/shared";
import { injectInto } from "./inject.js";

const LOAD_TIMEOUT_MS = 20_000;
const NEW_TAB_TIMEOUT_MS = 10_000;
const SETTLE_MS = 300;

/** CDP key definitions for keys a workflow can press. */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForLoad(tabId: number) {
  const end = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < end) {
    if ((await chrome.tabs.get(tabId)).status === "complete") return;
    await sleep(100);
  }
  throw new Error("page did not finish loading");
}

/**
 * Executes server commands in the browser. DOM work happens in the tab's content script;
 * input goes through the debugger (CDP) so pages receive trusted events with user activation.
 */
export class Executor {
  private attached = new Set<number>();
  private popupPolicy: { allowedOrigins: Set<string> } | undefined;
  /** Popup tabs whose URL isn't known yet, mapped to their opener. */
  private pendingPopups = new Map<number, number>();
  private closedPopups: string[] = [];
  /** Clicks waiting for the tab they open, by opener tab. */
  private newTabWaiters = new Map<number, (tabId: number) => void>();

  constructor() {
    chrome.debugger.onDetach.addListener(({ tabId }) => {
      if (tabId !== undefined) this.attached.delete(tabId);
    });
    chrome.tabs.onCreated.addListener((tab) => {
      // Only tabs a page opened (window.open, target=_blank) have an opener; ours from openTab don't.
      if (tab.id === undefined || tab.openerTabId === undefined) return;
      const waiter = this.newTabWaiters.get(tab.openerTabId);
      if (waiter) {
        // A click said it would open this tab: hand it over instead of treating it as a popup.
        this.newTabWaiters.delete(tab.openerTabId);
        waiter(tab.id);
        return;
      }
      if (!this.popupPolicy) return;
      this.pendingPopups.set(tab.id, tab.openerTabId);
      this.checkPopup(tab.id, tab.pendingUrl ?? tab.url);
    });
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.url && this.pendingPopups.has(tabId)) this.checkPopup(tabId, info.url);
    });
    chrome.tabs.onRemoved.addListener((tabId) => this.pendingPopups.delete(tabId));
  }

  private checkPopup(tabId: number, url: string | undefined) {
    const opener = this.pendingPopups.get(tabId);
    if (!this.popupPolicy || opener === undefined || !url || !/^https?:/.test(url)) return; // wait for a real URL
    this.pendingPopups.delete(tabId);
    const { origin, host } = new URL(url);
    if (this.popupPolicy.allowedOrigins.has(origin)) return;
    this.closedPopups.push(host);
    chrome.tabs.remove(tabId).catch(() => {});
    chrome.tabs.update(opener, { active: true }).catch(() => {});
  }

  async run(cmd: Command): Promise<CommandResults[Command["op"]]> {
    switch (cmd.op) {
      case "openTab": {
        const tab = await chrome.tabs.create({ url: cmd.url, active: true });
        await waitForLoad(tab.id!);
        return { tabId: tab.id! };
      }
      case "findTab": {
        const tabs = await chrome.tabs.query({});
        return { tabId: tabs.find((t) => t.url?.startsWith(cmd.urlPrefix))?.id ?? null };
      }
      case "activateTab": {
        const tab = await chrome.tabs.update(cmd.tabId, { active: true });
        if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
        return null;
      }
      case "tabInfo": {
        const tab = await chrome.tabs.get(cmd.tabId);
        return { url: tab.url ?? "", title: tab.title ?? "" };
      }
      case "navigate":
        await chrome.tabs.update(cmd.tabId, { url: cmd.url });
        await sleep(SETTLE_MS);
        await waitForLoad(cmd.tabId);
        return null;
      case "click": {
        const { x, y } = await this.content<{ x: number; y: number }>(cmd.tabId, { type: "exec/locate", locator: cmd.locator });
        // Listen before clicking, so a tab that opens instantly isn't missed.
        const newTab = cmd.expectNewTab ? this.waitForNewTab(cmd.tabId) : undefined;
        try {
          await this.mouseClick(cmd.tabId, x, y);
        } catch (err) {
          this.newTabWaiters.delete(cmd.tabId);
          throw err;
        }
        if (!newTab) return { newTabId: null };
        const newTabId = await newTab;
        await waitForLoad(newTabId);
        return { newTabId };
      }
      case "closeTab":
        await chrome.tabs.remove(cmd.tabId);
        return null;
      case "fill":
        await this.fill(cmd.tabId, cmd.locator, cmd.value);
        return null;
      case "press":
        if (cmd.locator) await this.content(cmd.tabId, { type: "exec/focus", locator: cmd.locator });
        await this.key(cmd.tabId, cmd.key);
        return null;
      case "probe":
        return this.content(cmd.tabId, { type: "exec/probe", locator: cmd.locator, textIncludes: cmd.textIncludes });
      case "extract":
        return this.content(cmd.tabId, { type: "exec/extract", locator: cmd.locator, attr: cmd.attr });
      case "extractList":
        return this.content(cmd.tabId, {
          type: "exec/extractList", container: cmd.container, itemSelector: cmd.itemSelector, fields: cmd.fields,
        });
      case "lastCopied":
        return this.content(cmd.tabId, { type: "exec/lastCopied" });
      case "settle": {
        await sleep(SETTLE_MS);
        await waitForLoad(cmd.tabId);
        return { closedPopups: this.closedPopups.splice(0) };
      }
      case "setPopupPolicy":
        this.popupPolicy = cmd.enabled ? { allowedOrigins: new Set(cmd.allowedOrigins) } : undefined;
        this.pendingPopups.clear();
        this.closedPopups = [];
        return null;
      case "release":
        if (this.attached.has(cmd.tabId)) await chrome.debugger.detach({ tabId: cmd.tabId }).catch(() => {});
        this.attached.delete(cmd.tabId);
        return null;
      case "snapshot":
        return this.content(cmd.tabId, { type: "exec/snapshot" });
    }
  }

  private waitForNewTab(openerTabId: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.newTabWaiters.delete(openerTabId);
        reject(new Error("the click did not open a new tab"));
      }, NEW_TAB_TIMEOUT_MS);
      this.newTabWaiters.set(openerTabId, (tabId) => {
        clearTimeout(timer);
        resolve(tabId);
      });
    });
  }

  private async fill(tabId: number, locator: Locator, value: string) {
    const { isSelect } = await this.content<{ isSelect: boolean }>(tabId, { type: "exec/prepareFill", locator });
    if (!isSelect) {
      if (value === "") await this.key(tabId, "Backspace");
      else await this.cdp(tabId, "Input.insertText", { text: value });
    }
    const { value: actual } = await this.content<{ value: string }>(tabId, { type: "exec/readValue", locator });
    // Some inputs (selects, masked fields) ignore typed text; fall back to setting the value directly.
    if (actual !== value) await this.content(tabId, { type: "exec/setValue", locator, value });
  }

  private async mouseClick(tabId: number, x: number, y: number) {
    const base = { x, y, button: "left", clickCount: 1 };
    await this.cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await this.cdp(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  private async key(tabId: number, key: string) {
    const def = KEYS[key] ?? { code: key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
    const common = { key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
    await this.cdp(tabId, "Input.dispatchKeyEvent", { ...common, type: def.text ? "keyDown" : "rawKeyDown", text: def.text });
    await this.cdp(tabId, "Input.dispatchKeyEvent", { ...common, type: "keyUp" });
  }

  private async cdp(tabId: number, method: string, params?: object) {
    if (!this.attached.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (err) {
        throw new Error(`cannot control tab (is DevTools open on it?): ${(err as Error).message}`);
      }
      this.attached.add(tabId);
    }
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  /** Sends a request to the tab's content script, injecting it first if the tab doesn't have one. */
  private async content<T>(tabId: number, req: { type: string; [k: string]: unknown }): Promise<T> {
    let res: { result?: T; error?: string } | undefined;
    try {
      res = await chrome.tabs.sendMessage(tabId, req, { frameId: 0 });
    } catch (err) {
      if (!/Receiving end does not exist|Could not establish connection/.test(String(err))) throw err;
    }
    if (res === undefined) {
      await injectInto(tabId);
      res = await chrome.tabs.sendMessage(tabId, req, { frameId: 0 });
    }
    if (!res) throw new Error("no response from page");
    if (res.error) throw new Error(res.error);
    return res.result as T;
  }
}
