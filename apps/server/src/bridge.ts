import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  type Command,
  ExtensionToServer,
  PROTOCOL_VERSION,
  type ServerToExtension,
} from "@d2a/shared";
import type { Store } from "./store.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** The single connection to the browser extension; sends commands and awaits their results. */
export class ExtensionBridge {
  private socket: WebSocket | undefined;
  private pending = new Map<string, Pending>();

  constructor(private store: Store) {}

  get connected() {
    return this.socket !== undefined;
  }

  attach(socket: WebSocket) {
    socket.on("message", (raw) => {
      let msg: ExtensionToServer;
      try {
        msg = ExtensionToServer.parse(JSON.parse(raw.toString()));
      } catch (err) {
        this.send(socket, { type: "error", message: `invalid message: ${(err as Error).message}` });
        return;
      }
      this.handle(socket, msg);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("extension disconnected"));
        this.pending.delete(id);
      }
    });
  }

  private handle(socket: WebSocket, msg: ExtensionToServer) {
    switch (msg.type) {
      case "hello":
        if (msg.version !== PROTOCOL_VERSION) {
          this.send(socket, { type: "error", message: `protocol ${msg.version} != ${PROTOCOL_VERSION}` });
          socket.close();
          return;
        }
        this.socket?.close();
        this.socket = socket;
        this.send(socket, { type: "welcome", version: PROTOCOL_VERSION });
        console.log(`extension connected: ${msg.extensionId}`);
        return;
      case "recordingStarted":
        this.store.createRecording(msg.recordingId, msg.name);
        return;
      case "recordedEvent":
        this.store.appendEvent(msg.recordingId, msg.data);
        return;
      case "ping":
      case "recordingStopped":
        return;
      case "commandResult": {
        const p = this.pending.get(msg.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.requestId);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? "command failed"));
        return;
      }
    }
  }

  execute(command: Command, timeoutMs = 30_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("extension not connected"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`command ${command.op} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(socket, { type: "command", requestId, command });
    });
  }

  private send(socket: WebSocket, msg: ServerToExtension) {
    socket.send(JSON.stringify(msg));
  }
}
