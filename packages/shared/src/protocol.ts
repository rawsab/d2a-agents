import { z } from "zod";
import { Fingerprint, RecordedEvent } from "./events.js";

export const SERVER_PORT = 7821;
export const PROTOCOL_VERSION = 1;

/** Low-level commands the server asks the extension to execute. */
export const Command = z.discriminatedUnion("op", [
  z.object({ op: z.literal("navigate"), tabId: z.number(), url: z.string() }),
  z.object({ op: z.literal("openTab"), url: z.string() }),
  z.object({ op: z.literal("click"), tabId: z.number(), target: Fingerprint }),
  z.object({ op: z.literal("fill"), tabId: z.number(), target: Fingerprint, value: z.string() }),
  z.object({ op: z.literal("press"), tabId: z.number(), key: z.string(), target: Fingerprint.optional() }),
  z.object({ op: z.literal("extract"), tabId: z.number(), target: Fingerprint, attr: z.string().optional() }),
  z.object({ op: z.literal("snapshot"), tabId: z.number() }),
]);
export type Command = z.infer<typeof Command>;

export const ExtensionToServer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.number(), extensionId: z.string() }),
  /** Keeps the MV3 service worker (and so the socket) alive. */
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("recordingStarted"), recordingId: z.string(), name: z.string() }),
  z.object({ type: z.literal("recordedEvent"), recordingId: z.string(), data: RecordedEvent }),
  z.object({ type: z.literal("recordingStopped"), recordingId: z.string() }),
  z.object({ type: z.literal("commandResult"), requestId: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }),
]);
export type ExtensionToServer = z.infer<typeof ExtensionToServer>;

export const ServerToExtension = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), version: z.number() }),
  z.object({ type: z.literal("command"), requestId: z.string(), command: Command }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerToExtension = z.infer<typeof ServerToExtension>;
