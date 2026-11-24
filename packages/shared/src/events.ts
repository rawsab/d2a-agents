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

const base = {
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
  z.object({ ...base, type: z.literal("navigate"), fromUrl: z.string().optional() }),
  z.object({ ...base, type: z.literal("tabCreated"), openerTabId: z.number().optional() }),
  z.object({ ...base, type: z.literal("tabActivated") }),
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
});
export type Recording = z.infer<typeof Recording>;
