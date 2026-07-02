/**
 * Local dashboard server for the b2b-overtime data.
 *
 * Serves a single static page (`public/index.html`) and one JSON endpoint that
 * reads the activity already ingested into Neon and returns the per-day table +
 * activity heatmap. The DATABASE_URL never leaves the server — the browser only
 * ever talks to this local process.
 *
 *   pnpm dashboard            # http://localhost:8787
 *   PORT=9000 pnpm dashboard  # custom port
 *   pnpm dashboard --port 9000
 *
 * Read-only: it does not collect or write anything. Run `pnpm overtime` to
 * refresh the underlying data.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildReport, defaultRange } from "../src/overtime/report.ts";
import { closeDb } from "#db";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "public", "index.html");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const { values } = parseArgs({ options: { port: { type: "string" } } });
const PORT = Number(values.port ?? process.env.PORT ?? 8787);

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function handleApi(url: URL, res: import("node:http").ServerResponse): Promise<void> {
  const def = defaultRange();
  const start = url.searchParams.get("start") ?? def.start;
  const end = url.searchParams.get("end") ?? def.end;
  const gapRaw = url.searchParams.get("gap");

  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    sendJson(res, 400, { error: "start and end must be YYYY-MM-DD" });
    return;
  }
  const gap = gapRaw != null ? Number(gapRaw) : undefined;
  if (gap != null && (!Number.isFinite(gap) || gap <= 0)) {
    sendJson(res, 400, { error: "gap must be a positive number of minutes" });
    return;
  }

  try {
    const report = await buildReport({ start, end, gap });
    sendJson(res, 200, report);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/api/overtime") {
      await handleApi(url, res);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(INDEX_HTML);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`b2b-overtime dashboard → http://localhost:${PORT}`);
  console.log("(read-only view of Neon; run `pnpm overtime` to refresh data. Ctrl-C to stop.)");
});

async function shutdown(): Promise<void> {
  server.close();
  try {
    await closeDb();
  } catch {
    /* connection may never have opened */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
