import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const SITE = join(import.meta.dirname, "site");
const PAGES: Record<string, string> = {
  "/list.html": "list.html",
  "/watch": "list.html",
  "/form.html": "form.html",
  "/ad.html": "ad.html",
};

/** Static fixture site plus a /log endpoint recording every "download" request. */
export async function startFixtureServer(port = 0) {
  const log: string[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/log" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      log.push(JSON.parse(body).url);
      res.writeHead(204).end();
    } else if (path === "/log") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(log));
    } else if (PAGES[path]) {
      res.writeHead(200, { "content-type": "text/html" }).end(await readFile(join(SITE, PAGES[path])));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${actual}`, log, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin } = await startFixtureServer(Number(process.env.PORT ?? 7822));
  console.log(`fixture site: ${origin}/list.html and ${origin}/form.html`);
}
