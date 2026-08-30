/** Wire types shared by the studio server and its browser pages. */

/** The project the studio was launched in. The studio is scoped to it. */
export interface ProjectInfo {
  /** Absolute path of the project directory. */
  id: string;
  /** Last path segment, for display. */
  name: string;
}

/** A graph in the shared, user-level library. */
export interface GraphSummary {
  id: string;
  name: string;
  /** `library` if user-editable, `bundled` if it ships with graph-agent. */
  source: "library" | "bundled";
}

/** One BPMN activity that carried an agent turn, in execution order. */
export interface TurnRecord {
  index: number;
  activityId: string;
  activityName?: string;
  /** The zeebe:taskDefinition job type that dispatched it. */
  harness?: string;
  stopReason?: string;
  toolCalls?: string[];
  summary?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /** Token usage for the turn, so cache behaviour is visible per step. */
  usage?: TurnUsage;
}

/**
 * Per-turn token usage. `cacheRead` is the number that matters here: a
 * graph-coordinated run should be reusing one Pi session, so every turn after
 * the first ought to read most of its prefix from cache.
 */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A saved version of the session graph. Sessions mutate, so this is a history. */
export interface GraphRevision {
  index: number;
  at: number;
  reason: string;
  addedElementIds: string[];
}

export interface SessionSummary {
  id: string;
  /** Absolute path of the project directory the session ran against. */
  project: string;
  name?: string;
  /**
   * `stale` is never written directly -- it is `SessionStore.summary()`
   * reporting a `"running"` session whose recorded pid is no longer alive,
   * rather than a phantom "running" forever (issue #52).
   */
  status: "running" | "wait" | "timer" | "idle" | "completed" | "error" | "stale";
  updatedAt: number;
  turnCount: number;
}

export interface SessionDetail extends SessionSummary {
  /** Current BPMN XML: the graph as it now stands, splices included. */
  graph: string;
  /** Activity ids the token is currently standing on. */
  tokens: string[];
  /** Activity ids already executed at least once. */
  visited: string[];
  turns: TurnRecord[];
  revisions: GraphRevision[];
  /** Set by a harness that gave up and deliberately ended the run outside the ordinary turn path. */
  harnessError?: string;
}

/** A parked human gate (`GET /api/sessions/:id/pending`, issue #51). */
export interface PendingGateInfo {
  id: string;
  name?: string;
  documentation?: string;
  form?: { formId: string; schema: string };
  /** An answer is already queued for this gate, waiting for a runner to consume it. */
  answered: boolean;
}

/** Pushed over the studio WebSocket when a session advances or its graph changes. */
export type StudioEvent =
  | { type: "session_changed"; sessionId: string }
  | { type: "sessions_changed" }
  | { type: "graphs_changed" };
