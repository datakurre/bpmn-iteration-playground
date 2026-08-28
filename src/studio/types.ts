/** Wire types shared by the studio server and its browser pages. */

export interface WorkflowSummary {
  id: string;
  name: string;
}

/** One BPMN activity that carried an agent turn, in execution order. */
export interface TurnRecord {
  index: number;
  activityId: string;
  activityName?: string;
  harness?: string;
  /** Assistant stop reason for `agent:turn` activities. */
  stopReason?: string;
  toolCalls?: string[];
  summary?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

/** A saved version of the session graph. The session mutates, so this is a history. */
export interface GraphRevision {
  index: number;
  at: number;
  reason: string;
  addedElementIds: string[];
}

export interface SessionSummary {
  id: string;
  name?: string;
  status: "running" | "wait" | "timer" | "idle" | "completed" | "error";
  updatedAt: number;
  turnCount: number;
}

export interface SessionDetail extends SessionSummary {
  /** Current BPMN XML: the graph as it now stands, splices included. */
  graph: string;
  /** Activity ids the token is currently standing on (postponed/waiting). */
  tokens: string[];
  /** Activity ids already executed at least once. */
  visited: string[];
  turns: TurnRecord[];
  revisions: GraphRevision[];
}

/** Pushed over the studio WebSocket when a session advances or its graph changes. */
export type StudioEvent =
  | { type: "session_changed"; sessionId: string }
  | { type: "sessions_changed" };
