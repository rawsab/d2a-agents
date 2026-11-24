import { type ExtensionToServer, ServerToExtension } from "@d2a/shared";

const PING_MS = 20_000;
const MAX_BACKOFF_MS = 10_000;

/** Auto-reconnecting WebSocket to the local server. */
export class ServerConnection {
  private ws: WebSocket | undefined;
  private backoff = 500;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private messageHandlers: ((msg: ServerToExtension) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  ready = false;

  constructor(private url: string) {}

  onMessage(fn: (msg: ServerToExtension) => void) {
    this.messageHandlers.push(fn);
  }

  onOpen(fn: () => void) {
    this.openHandlers.push(fn);
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.openHandlers.forEach((fn) => fn());
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_MS);
    };
    ws.onmessage = (ev) => {
      const parsed = ServerToExtension.safeParse(JSON.parse(ev.data));
      if (!parsed.success) return console.warn("bad server message", parsed.error);
      if (parsed.data.type === "welcome") this.ready = true;
      if (parsed.data.type === "error") console.warn("server error:", parsed.data.message);
      this.messageHandlers.forEach((fn) => fn(parsed.data));
    };
    ws.onclose = () => {
      this.ready = false;
      clearInterval(this.pingTimer);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  send(msg: ExtensionToServer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
