import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { listSessions, SessionStore } from "../agent/session-store.ts";
import {
  bundledWorkflowsDir,
  elementTemplatesDir,
  listBpmnFiles,
  packageRoot,
  staticDir,
  type Workspace,
} from "../agent/workspace.ts";
import type { StudioEvent, WorkflowSummary } from "./types.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".png": "image/png",
  ".bpmn": "application/xml; charset=utf-8",
};

export interface StudioOptions {
  workspace: Workspace;
  host?: string;
  port?: number;
}

export interface Studio {
  url: string;
  port: number;
  broadcast(event: StudioEvent): void;
  close(): Promise<void>;
}

export async function startStudio(options: StudioOptions): Promise<Studio> {
  const { workspace } = options;
  const host = options.host ?? "127.0.0.1";
  const pagesDir = join(staticDir(), "pages");

  const server = createServer((req, res) => {
    void handle(req, res, workspace, pagesDir).catch((error: unknown) => {
      send(res, 500, "text/plain", error instanceof Error ? error.message : String(error));
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
  });

  const broadcast = (event: StudioEvent): void => {
    const payload = JSON.stringify(event);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  // A `graph-agent run` in another process writes into .agents/sessions; watching
  // the directory is what makes a running session animate in the browser.
  const watcher = existsSync(workspace.sessionsDir)
    ? watch(workspace.sessionsDir, { recursive: true }, (_event, filename) => {
        const sessionId = filename ? String(filename).split(sep)[0] : undefined;
        broadcast(sessionId ? { type: "session_changed", sessionId } : { type: "sessions_changed" });
      })
    : null;

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    url: `http://${host}:${port}`,
    port,
    broadcast,
    close: () =>
      new Promise<void>((done) => {
        watcher?.close();
        for (const socket of clients) socket.terminate();
        wss.close(() => server.close(() => done()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  workspace: Workspace,
  pagesDir: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // ---- pages
  if (path === "/") return sendPage(res, pagesDir, "index.html");
  if (path === "/editor") return sendPage(res, pagesDir, "editor.html");
  if (path === "/session") return sendPage(res, pagesDir, "session.html");

  // ---- static assets
  if (path.startsWith("/static/")) {
    const rel = path.slice("/static/".length);
    const file = safeJoin(staticDir(), rel);
    if (!file || !existsSync(file)) return send(res, 404, "text/plain", "not found");
    return send(res, 200, mimeFor(file), readFileSync(file));
  }

  // ---- workflow API (the editor page speaks this vocabulary verbatim)
  if (path === "/api/templates") {
    return sendJson(res, 200, workflowList(workspace));
  }
  const xmlMatch = /^\/api\/templates\/([^/]+)\/xml$/.exec(path);
  if (xmlMatch) {
    const file = workflowPath(workspace, decodeURIComponent(xmlMatch[1] as string));
    if (!file) return send(res, 404, "text/plain", "unknown workflow");
    return send(res, 200, "application/xml; charset=utf-8", readFileSync(file));
  }
  if (path === "/api/workflows/save" && req.method === "POST") {
    const body = (await readJson(req)) as { name?: string; xml?: string };
    if (!body.name || !body.xml) return sendJson(res, 400, { error: "name and xml are required" });
    const safeName = body.name.replace(/[^A-Za-z0-9_-]/g, "_");
    const target = join(workspace.workflowsDir, `${safeName}.bpmn`);
    writeFileSync(target, body.xml);
    return sendJson(res, 200, { path: target, process_ids: processIds(body.xml) });
  }
  if (path === "/api/element-templates") {
    return sendJson(res, 200, elementTemplates());
  }

  // ---- session API
  if (path === "/api/sessions") {
    return sendJson(res, 200, listSessions(workspace).map((s) => s.summary()));
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch) {
    const store = new SessionStore(workspace, decodeURIComponent(sessionMatch[1] as string));
    if (!store.exists()) return sendJson(res, 404, { error: "unknown session" });
    return sendJson(res, 200, store.detail());
  }

  send(res, 404, "text/plain", "not found");
}

/** Workflows come from the workspace first, with the bundled library behind them. */
export function workflowList(workspace: Workspace): WorkflowSummary[] {
  const seen = new Map<string, WorkflowSummary>();
  for (const dir of [bundledWorkflowsDir(), workspace.workflowsDir]) {
    for (const { id } of listBpmnFiles(dir)) {
      seen.set(id, { id, name: id.replace(/[-_]/g, " ") });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function workflowPath(workspace: Workspace, id: string): string | null {
  for (const dir of [workspace.workflowsDir, bundledWorkflowsDir()]) {
    const file = safeJoin(dir, `${id}.bpmn`);
    if (file && existsSync(file)) return file;
  }
  return null;
}

function elementTemplates(): unknown[] {
  const out: unknown[] = [];
  for (const dir of [elementTemplatesDir(), join(packageRoot(), "element_templates")]) {
    if (!existsSync(dir)) continue;
    for (const { path } of listJsonFiles(dir)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    }
    break;
  }
  return out;
}

function listJsonFiles(dir: string): Array<{ path: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ path: join(dir, f) }));
}

/** Cheap scan; the engine is the authority, this is only for the save confirmation. */
export function processIds(xml: string): string[] {
  return [...xml.matchAll(/<(?:bpmn:)?process\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1] as string);
}

/** Reject any path that escapes `root` after normalisation. */
export function safeJoin(root: string, rel: string): string | null {
  const target = resolve(root, normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ""));
  const base = resolve(root);
  return target === base || target.startsWith(base + sep) ? target : null;
}

function mimeFor(file: string): string {
  return MIME[extname(file)] ?? "application/octet-stream";
}

function sendPage(res: ServerResponse, pagesDir: string, name: string): void {
  const file = join(pagesDir, name);
  if (!existsSync(file)) return send(res, 404, "text/plain", `missing page: ${name}`);
  send(res, 200, "text/html; charset=utf-8", readFileSync(file));
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

export type { Server };
