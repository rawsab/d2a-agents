import { SERVER_PORT } from "@d2a/shared";

declare const __D2A_PORT__: string;

/** Build-time override (D2A_PORT) lets e2e tests run alongside a dev server. */
const port = Number(__D2A_PORT__) || SERVER_PORT;
export const API_URL = `http://127.0.0.1:${port}`;
export const WS_URL = `ws://127.0.0.1:${port}/ws`;
