import { z } from "zod";

/** Multiple locator candidates for one element; no single locator is robust. */
export const Fingerprint = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  testId: z.string().optional(),
  id: z.string().optional(),
  nameAttr: z.string().optional(),
  css: z.string().optional(),
  xpath: z.string().optional(),
  /** Absolute URL for links; lets the compiler read data straight from the DOM. */
  href: z.string().optional(),
  bbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
  /** Trimmed outerHTML of the element and its parent ("inspect element" context). */
  html: z.string().optional(),
});
export type Fingerprint = z.infer<typeof Fingerprint>;

/** Visible interactive elements available in a page state; feeds the editor's element picker. */
export const PageInventory = z.array(
  z.object({ tag: z.string(), fingerprint: Fingerprint }),
);
export type PageInventory = z.infer<typeof PageInventory>;

/** What an action changed, measured over a short window after it (and the same window before, as baseline). */
export const Effect = z.object({
  windowMs: z.number(),
  mutations: z.number(),
  baselineMutations: z.number(),
  requests: z.number(),
  baselineRequests: z.number(),
  urlChanged: z.boolean(),
  /** Focus moved somewhere other than the element acted on. */
  focusMoved: z.boolean(),
  /** The element's aria-expanded changed (menus, dropdowns, accordions). */
  expandedChanged: z.boolean(),
  /** Dialogs, menus and popovers that appeared / disappeared. */
  opened: z.array(z.string()),
  closed: z.array(z.string()),
  copied: z.boolean(),
  /** The page unloaded before the window ended (the action navigated). */
  unloaded: z.boolean(),
});
export type Effect = z.infer<typeof Effect>;

const base = {
  /** Set on actions so a later "effect" event can refer to them. */
  id: z.string().optional(),
  tabId: z.number(),
  url: z.string(),
  title: z.string().optional(),
  ts: z.number(),
};

export const RawEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("click"), target: Fingerprint }),
  z.object({ ...base, type: z.literal("input"), target: Fingerprint, value: z.string(), masked: z.boolean().default(false) }),
  z.object({ ...base, type: z.literal("keydown"), target: Fingerprint, key: z.string() }),
  z.object({ ...base, type: z.literal("submit"), target: Fingerprint }),
  z.object({ ...base, type: z.literal("copy"), target: Fingerprint.optional(), value: z.string() }),
  z.object({ ...base, type: z.literal("paste"), target: Fingerprint, value: z.string() }),
  z.object({
    ...base,
    type: z.literal("navigate"),
    transitionType: z.string().optional(),
    transitionQualifiers: z.array(z.string()).optional(),
  }),
  z.object({ ...base, type: z.literal("tabCreated"), openerTabId: z.number().optional() }),
  z.object({ ...base, type: z.literal("tabActivated") }),
  z.object({ ...base, type: z.literal("effect"), actionId: z.string(), effect: Effect }),
]);
export type RawEvent = z.infer<typeof RawEvent>;

/** A raw event plus the page context captured alongside it. */
export const RecordedEvent = z.object({
  event: RawEvent,
  inventory: PageInventory.optional(),
  screenshotId: z.string().optional(),
});
export type RecordedEvent = z.infer<typeof RecordedEvent>;

export const Recording = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  events: z.array(RecordedEvent),
  /** User decisions keyed by a step's first event index: true = noise, false = keep. */
  overrides: z.record(z.boolean()).optional(),
});
export type Recording = z.infer<typeof Recording>;
