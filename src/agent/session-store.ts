import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphRevision, SessionDetail, SessionSummary, TurnRecord } from "../studio/types.ts";
import type { Paths } from "./paths.ts";

/**
 * On-disk shape of a session, under the user-level state directory.
 *
 *   $XDG_STATE_HOME/graph-agent/sessions/<id>/
 *     meta.json        session identity, the project it ran against, and history
 *     engine.json      bpmn-engine state snapshot (source stripped; see graph/)
 *     graph/000.bpmn   graph revisions, oldest first -- the session mutates, so
 *     graph/001.bpmn   every splice lands as a new revision rather than an overwrite
 *     session.jsonl    Pi's own transcript, written by Pi's SessionManager
 *
 * Ordering matters on write: the transcript is Pi's, the graph revision is ours,
 * and the engine snapshot points at both. Committing them in that order means a
 * crash can leave a revision with no engine state (recoverable by replaying to the
 * last snapshot) but never engine state referencing a graph that was never written.
 */
export interface SessionMeta {
  id: string;
  name?: string;
  /** Absolute path of the project directory this session ran against. */
  project: string;
  status: SessionSummary["status"];
  createdAt: number;
  updatedAt: number;
  turns: TurnRecord[];
  revisions: GraphRevision[];
  /** Activity ids the token currently rests on. */
  tokens: string[];
  /** Activity ids executed at least once. */
  visited: string[];
  /**
   * The pid of the process currently driving this session, set while
   * `status` is `"running"` and cleared once it settles. Lets `summary()`
   * tell a genuinely live run apart from one a killed process left claiming
   * to be running forever (issue #52).
   */
  pid?: number;
  startedAt?: number;
  /**
   * Set by a harness that gave up and deliberately ended the run outside the
   * ordinary agent:turn path (graph:lint's redraft-attempt cap, chiefly).
   * bpmn-elements re-wraps a thrown error at every callActivity boundary it
   * crosses, and the original message is not reliably reachable off the
   * resulting error's own `.message` by the time it reaches the CLI -- this
   * is a channel this project controls instead.
   */
  harnessError?: string;
}

export class SessionStore {
  constructor(
    private readonly paths: Paths,
    readonly id: string,
  ) {}

  get dir(): string {
    return join(this.paths.sessionsDir, this.id);
  }

  get graphDir(): string {
    return join(this.dir, "graph");
  }

  get metaPath(): string {
    return join(this.dir, "meta.json");
  }

  get enginePath(): string {
    return join(this.dir, "engine.json");
  }

  get transcriptPath(): string {
    return join(this.dir, "session.jsonl");
  }

  exists(): boolean {
    return existsSync(this.metaPath);
  }

  create(project: string, name?: string): SessionMeta {
    mkdirSync(this.graphDir, { recursive: true });
    const now = Date.now();
    const meta: SessionMeta = {
      id: this.id,
      project,
      ...(name === undefined ? {} : { name }),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      turns: [],
      revisions: [],
      tokens: [],
      visited: [],
    };
    this.writeMeta(meta);
    return meta;
  }

  readMeta(): SessionMeta {
    return JSON.parse(readFileSync(this.metaPath, "utf8")) as SessionMeta;
  }

  writeMeta(meta: SessionMeta): void {
    mkdirSync(this.dir, { recursive: true });
    meta.updatedAt = Date.now();
    writeAtomic(this.metaPath, JSON.stringify(meta, null, 2));
  }

  update(mutate: (meta: SessionMeta) => void): SessionMeta {
    const meta = this.readMeta();
    mutate(meta);
    this.writeMeta(meta);
    return meta;
  }

  /** Revision file names, oldest first. */
  graphRevisionFiles(): string[] {
    if (!existsSync(this.graphDir)) return [];
    return readdirSync(this.graphDir)
      .filter((f) => f.endsWith(".bpmn"))
      .sort();
  }

  /** Append a new graph revision and record it in meta. */
  appendGraph(xml: string, reason: string, addedElementIds: string[] = []): GraphRevision {
    mkdirSync(this.graphDir, { recursive: true });
    const index = this.graphRevisionFiles().length;
    writeAtomic(join(this.graphDir, `${String(index).padStart(3, "0")}.bpmn`), xml);
    const revision: GraphRevision = { index, at: Date.now(), reason, addedElementIds };
    this.update((meta) => {
      meta.revisions.push(revision);
    });
    return revision;
  }

  /** The graph as it now stands. */
  currentGraph(): string | null {
    const files = this.graphRevisionFiles();
    const last = files[files.length - 1];
    return last === undefined ? null : readFileSync(join(this.graphDir, last), "utf8");
  }

  readEngineState(): unknown | null {
    if (!existsSync(this.enginePath)) return null;
    return JSON.parse(readFileSync(this.enginePath, "utf8")) as unknown;
  }

  writeEngineState(state: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.enginePath, JSON.stringify(state));
  }

  summary(): SessionSummary {
    const meta = this.readMeta();
    return {
      id: meta.id,
      project: meta.project,
      ...(meta.name === undefined ? {} : { name: meta.name }),
      status: effectiveStatus(meta),
      updatedAt: meta.updatedAt,
      turnCount: meta.turns.length,
    };
  }

  detail(): SessionDetail {
    const meta = this.readMeta();
    return {
      ...this.summary(),
      graph: this.currentGraph() ?? "",
      tokens: meta.tokens,
      visited: meta.visited,
      turns: meta.turns,
      revisions: meta.revisions,
      ...(meta.harnessError === undefined ? {} : { harnessError: meta.harnessError }),
    };
  }
}

/**
 * Sessions, newest first. `project` narrows to one project directory -- the
 * usual case, since the CLI and studio both run inside one.
 */
export function listSessions(paths: Paths, project?: string): SessionStore[] {
  if (!existsSync(paths.sessionsDir)) return [];
  return readdirSync(paths.sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => new SessionStore(paths, e.name))
    .filter((s) => s.exists())
    .filter((s) => project === undefined || s.readMeta().project === project)
    .sort((a, b) => b.readMeta().updatedAt - a.readMeta().updatedAt);
}

/** Whether `pid` still names a live process (issue #52). `EPERM` means alive, just owned by someone else. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `meta.status`, except a `"running"` session whose recorded process is gone reports `"stale"` instead. */
function effectiveStatus(meta: SessionMeta): SessionSummary["status"] {
  if (meta.status === "running" && (meta.pid === undefined || !isProcessAlive(meta.pid))) return "stale";
  return meta.status;
}

/** Write via a temp file + rename so a reader never observes a half-written file. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}
