/**
 * The studio server.
 *
 * Not a global workflow tool: it is launched from a project directory and is
 * scoped to it. Two jobs, matching the two halves of the vision --
 *
 *   visualize: the graph of a session running against *this* project, with the
 *              token where it currently stands and the turn history beside it
 *   model:     the shared, user-level graph library, edited with bpmn-js
 *
 * Sessions are read from XDG_STATE_HOME and filtered to this project. Graphs
 * come from XDG_CONFIG_HOME and are deliberately *not* project-scoped: a loop
 * that works well here is worth having on the next codebase too.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { listSessions, SessionStore } from "../agent/session-store.ts";
import {
  bundledWorkflowsDir,
  elementTemplatesDir,
  listBpmnFiles,
  projectName,
  staticDir,
  type Paths,
} from "../agent/paths.ts";
import { checkMigration } from "../agent/graph.ts";
import { createHarnesses, type HarnessDeps } from "../agent/harnesses.ts";
import type { GraphSummary, ProjectInfo, StudioEvent } from "./types.ts";

/** The harness registry's own keys, for checkMigration's job-type contract -- no live deps are ever invoked here, only Object.keys(). */
const KNOWN_JOB_TYPES = new Set(
  Object.keys(
    createHarnesses({
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store: {} as HarnessDeps["store"],
      getGraph: () => "",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    }),
  ),
);

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
  paths: Paths;
  /** Absolute path of the project the studio is scoped to. */
  project: string;
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
  const { paths, project } = options;
  const host = options.host ?? "127.0.0.1";
  const pagesDir = join(staticDir(), "pages");

  const server = createServer((req, res) => {
    void handle(req, res, options, pagesDir, broadcast).catch((error: unknown) => {
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

  // A `graph-agent run` in another terminal writes into the state directory;
  // watching it is what makes a running session animate in the browser.
  const watchers = [
    watchDir(paths.sessionsDir, (name) => {
      const sessionId = name ? String(name).split(sep)[0] : undefined;
      broadcast(sessionId ? { type: "session_changed", sessionId } : { type: "sessions_changed" });
    }),
    watchDir(paths.workflowsDir, () => broadcast({ type: "graphs_changed" })),
  ];

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });

  void project;
  return {
    url: `http://${host}:${port}`,
    port,
    broadcast,
    close: () =>
      new Promise<void>((done) => {
        for (const w of watchers) w?.close();
        for (const socket of clients) socket.terminate();
        wss.close(() => server.close(() => done()));
      }),
  };
}

function watchDir(dir: string, onChange: (name: string | null) => void): { close(): void } | null {
  if (!existsSync(dir)) return null;
  return watch(dir, { recursive: true }, (_event, filename) => onChange(filename ? String(filename) : null));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: StudioOptions,
  pagesDir: string,
  broadcast: (event: StudioEvent) => void,
): Promise<void> {
  const { paths, project } = options;
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // ---- pages
  if (path === "/") return sendPage(res, pagesDir, "project.html");
  if (path === "/session") return sendPage(res, pagesDir, "session.html");
  if (path === "/graph") return sendPage(res, pagesDir, "graph.html");

  // ---- static assets
  if (path.startsWith("/static/")) {
    const file = safeJoin(staticDir(), path.slice("/static/".length));
    if (!file || !existsSync(file)) return send(res, 404, "text/plain", "not found");
    return send(res, 200, mimeFor(file), readFileSync(file));
  }

  // ---- the project this studio is scoped to
  if (path === "/api/project") {
    const info: ProjectInfo = { id: project, name: projectName(project) };
    return sendJson(res, 200, info);
  }

  // ---- sessions, this project's unless asked otherwise
  if (path === "/api/sessions") {
    const scope = url.searchParams.get("scope") === "all" ? undefined : project;
    return sendJson(res, 200, listSessions(paths, scope).map((s) => s.summary()));
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch) {
    const store = new SessionStore(paths, decodeURIComponent(sessionMatch[1] as string));
    if (!store.exists()) return sendJson(res, 404, { error: "unknown session" });
    return sendJson(res, 200, store.detail());
  }

  // ---- a session's own graph: read it, or edit it with the migration guard
  // (issue #46) rather than the library's stricter, additive-only checkSplice.
  const sessionGraphMatch = /^\/api\/sessions\/([^/]+)\/graph$/.exec(path);
  if (sessionGraphMatch) {
    const store = new SessionStore(paths, decodeURIComponent(sessionGraphMatch[1] as string));
    if (!store.exists()) return sendJson(res, 404, { error: "unknown session" });

    if (req.method === "PUT") {
      const body = (await readJson(req)) as { xml?: string };
      if (!body.xml) return sendJson(res, 400, { error: "xml is required" });
      const current = store.currentGraph();
      if (current === null) return sendJson(res, 404, { error: "session has no graph" });

      const meta = store.readMeta();
      const live = new Set([...meta.visited, ...meta.tokens]);
      let check;
      try {
        check = await checkMigration(current, body.xml, live, KNOWN_JOB_TYPES);
      } catch (error) {
        return sendJson(res, 400, { error: `not valid BPMN: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (!check.ok) return sendJson(res, 409, { error: check.reason, removed: check.removed });

      store.appendGraph(body.xml, "studio edit", []);
      broadcast({ type: "session_changed", sessionId: store.id });
      return sendJson(res, 200, { revisions: store.readMeta().revisions.length });
    }

    const xml = store.currentGraph();
    if (xml === null) return sendJson(res, 404, { error: "session has no graph" });
    return send(res, 200, "application/xml; charset=utf-8", xml);
  }

  // ---- the shared graph library
  if (path === "/api/graphs") return sendJson(res, 200, graphList(paths));
  const graphMatch = /^\/api\/graphs\/([^/]+)$/.exec(path);
  if (graphMatch) {
    const id = decodeURIComponent(graphMatch[1] as string);
    if (req.method === "PUT") {
      const body = (await readJson(req)) as { xml?: string };
      if (!body.xml) return sendJson(res, 400, { error: "xml is required" });
      const target = safeJoin(paths.workflowsDir, `${safeId(id)}.bpmn`);
      if (!target) return sendJson(res, 400, { error: "bad graph id" });
      writeFileSync(target, body.xml);
      return sendJson(res, 200, { id: safeId(id), path: target, processIds: processIds(body.xml) });
    }
    const file = graphPath(paths, id);
    if (!file) return send(res, 404, "text/plain", "unknown graph");
    return send(res, 200, "application/xml; charset=utf-8", readFileSync(file));
  }

  if (path === "/api/element-templates") return sendJson(res, 200, elementTemplates());

  send(res, 404, "text/plain", "not found");
}

/**
 * The library the user edits, with the bundled graphs behind it. A user-level
 * copy shadows a bundled one of the same name, so the built-ins can be adapted
 * without being lost.
 */
export function graphList(paths: Paths): GraphSummary[] {
  const seen = new Map<string, GraphSummary>();
  for (const { id } of listBpmnFiles(bundledWorkflowsDir())) {
    seen.set(id, { id, name: id.replace(/[-_]/g, " "), source: "bundled" });
  }
  for (const { id } of listBpmnFiles(paths.workflowsDir)) {
    seen.set(id, { id, name: id.replace(/[-_]/g, " "), source: "library" });
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function graphPath(paths: Paths, id: string): string | null {
  for (const dir of [paths.workflowsDir, bundledWorkflowsDir()]) {
    const file = safeJoin(dir, `${id}.bpmn`);
    if (file && existsSync(file)) return file;
  }
  return null;
}

export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function elementTemplates(): unknown[] {
  const dir = elementTemplatesDir();
  if (!existsSync(dir)) return [];
  const out: unknown[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out;
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
