import { z } from "zod";
import { Fingerprint, PageInventory, RecordedEvent } from "./events.js";
import { ListField } from "./workflow.js";

export const SERVER_PORT = 7821;
export const PROTOCOL_VERSION = 1;

/** How the extension finds an element: fingerprint, optionally scoped to a container selector. */
export const Locator = z.object({ fingerprint: Fingerprint, within: z.string().optional() });
export type Locator = z.infer<typeof Locator>;

const tab = { tabId: z.number() };

/** Low-level commands the server asks the extension to execute. */
export const Command = z.discriminatedUnion("op", [
  z.object({ op: z.literal("openTab"), url: z.string() }),
  z.object({ op: z.literal("findTab"), urlPrefix: z.string() }),
  z.object({ op: z.literal("activateTab"), ...tab }),
  z.object({ op: z.literal("tabInfo"), ...tab }),
  z.object({ op: z.literal("navigate"), ...tab, url: z.string() }),
  /** With expectNewTab, waits for the tab the click opens (it is never treated as a popup). */
  z.object({ op: z.literal("click"), ...tab, locator: Locator, expectNewTab: z.boolean().optional() }),
  z.object({ op: z.literal("closeTab"), ...tab }),
  z.object({ op: z.literal("fill"), ...tab, locator: Locator, value: z.string() }),
  z.object({ op: z.literal("press"), ...tab, key: z.string(), locator: Locator.optional() }),
  /** With textIncludes, also checks the element's full text contains it (done in the page; probe text is truncated). */
  z.object({ op: z.literal("probe"), ...tab, locator: Locator, textIncludes: z.string().optional() }),
  z.object({ op: z.literal("extract"), ...tab, locator: Locator, attr: z.string().optional() }),
  z.object({
    op: z.literal("extractList"),
    ...tab,
    container: Locator.optional(),
    itemSelector: z.string(),
    fields: z.record(ListField),
  }),
  z.object({ op: z.literal("lastCopied"), ...tab }),
  /** Waits for the page to finish whatever the last action started. */
  z.object({ op: z.literal("settle"), ...tab }),
  /**
   * While enabled, tabs that pages open (they have an opener) on an origin not in allowedOrigins
   * are closed as soon as their URL is known, and the opener is re-activated.
   */
  z.object({ op: z.literal("setPopupPolicy"), enabled: z.boolean(), allowedOrigins: z.array(z.string()) }),
  /** Detaches the debugger from the tab. */
  z.object({ op: z.literal("release"), ...tab }),
  z.object({ op: z.literal("snapshot"), ...tab }),
  /** JPEG of the visible part of the page, base64 (no data: prefix). */
  z.object({ op: z.literal("screenshot"), ...tab }),
]);
export type Command = z.infer<typeof Command>;
export type CommandOf<K extends Command["op"]> = Extract<Command, { op: K }>;

/** Each list item also carries its position and a unique selector, used by `within` targets. */
export type ListItem = Record<string, string | number> & { _index: number; _selector: string };

export type CommandResults = {
  openTab: { tabId: number };
  findTab: { tabId: number | null };
  activateTab: null;
  tabInfo: { url: string; title: string };
  navigate: null;
  click: { newTabId: number | null };
  closeTab: null;
  fill: null;
  press: null;
  probe: { found: boolean; text?: string; textMatched?: boolean; error?: string };
  extract: string;
  extractList: ListItem[];
  lastCopied: { value: string; ts: number } | null;
  /** Hosts of popup tabs closed since the previous settle. */
  settle: { closedPopups: string[] };
  setPopupPolicy: null;
  release: null;
  snapshot: PageInventory;
  screenshot: { data: string };
};

export const ExtensionToServer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.number(), extensionId: z.string() }),
  /** Keeps the MV3 service worker (and so the socket) alive. */
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("recordingStarted"), recordingId: z.string(), name: z.string() }),
  z.object({ type: z.literal("recordedEvent"), recordingId: z.string(), data: RecordedEvent }),
  z.object({ type: z.literal("recordingStopped"), recordingId: z.string() }),
  z.object({ type: z.literal("screenshot"), recordingId: z.string(), id: z.string(), dataUrl: z.string() }),
  z.object({ type: z.literal("commandResult"), requestId: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }),
]);
export type ExtensionToServer = z.infer<typeof ExtensionToServer>;

export const ServerToExtension = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), version: z.number() }),
  z.object({ type: z.literal("command"), requestId: z.string(), command: Command }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerToExtension = z.infer<typeof ServerToExtension>;
