/**
 * Running a session.
 *
 * The BPMN engine holds the control flow, the Pi session holds the transcript,
 * and the store holds both on disk. The three are committed in a fixed order --
 * transcript, then graph revision, then engine state -- so a crash can leave a
 * revision with no snapshot (recoverable by replaying) but never a snapshot
 * pointing at a graph that was never written.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runGraph, resumeGraph, type RunResult } from "./engine.ts";
import { createHarnesses } from "./harnesses.ts";
import { PiSession } from "./pi-session.ts";
import { SessionStore } from "./session-store.ts";
import type { ToolExecutor } from "./tool-executor.ts";
import type { EngineState } from "./graph.ts";
import type { Paths } from "./paths.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";

export interface RunSessionOptions {
  paths: Paths;
  project: string;
  /** Graph to start from; a path to a `.bpmn` file. */
  graphPath: string;
  prompt?: string;
  name?: string;
  model: Model<any>;
  systemPrompt: string;
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
  tools: ToolExecutor;
  sessionId?: string;
  /** Emitted as the run progresses, for the CLI to print. */
  onProgress?: (line: string) => void;
}

export interface SessionOutcome {
  sessionId: string;
  outcome: RunResult["outcome"];
  turns: number;
  error?: Error;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent whose control flow is described by a BPMN process. " +
  "Do the work the current step asks for and nothing more.";

export async function runSession(options: RunSessionOptions): Promise<SessionOutcome> {
  const sessionId = options.sessionId ?? randomUUID().slice(0, 8);
  const store = new SessionStore(options.paths, sessionId);
  if (!store.exists()) store.create(options.project, options.name);

  const graph = readFileSync(options.graphPath, "utf8");
  store.appendGraph(graph, `started from ${options.graphPath}`, []);

  return drive(store, options, (harnessOptions) => runGraph(store.currentGraph() ?? graph, harnessOptions));
}

export interface ResumeSessionOptions extends Omit<RunSessionOptions, "graphPath" | "prompt" | "name"> {
  sessionId: string;
}

export async function resumeSession(options: ResumeSessionOptions): Promise<SessionOutcome> {
  const store = new SessionStore(options.paths, options.sessionId);
  if (!store.exists()) throw new Error(`unknown session '${options.sessionId}'`);
  const state = store.readEngineState() as EngineState | null;
  if (!state) throw new Error(`session '${options.sessionId}' has no saved engine state to resume`);
  const graph = store.currentGraph();
  if (!graph) throw new Error(`session '${options.sessionId}' has no graph`);

  return drive(store, options, (harnessOptions) =>
    resumeGraph(state, store.currentGraph() ?? graph, harnessOptions),
  );
}

type Drive = (harnessOptions: Parameters<typeof runGraph>[1]) => Promise<RunResult>;

async function drive(
  store: SessionStore,
  options: Omit<RunSessionOptions, "graphPath">,
  start: Drive,
): Promise<SessionOutcome> {
  const pi = new PiSession({
    model: options.model,
    systemPrompt: options.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    toolNames: options.tools.names(),
    streamFn: options.streamFn,
    sessionId: store.id,
  });

  // Steering and follow-up arrive from outside the graph; the graph decides when
  // to drain them. The initial prompt is not one of these -- it enters as a
  // process variable that the turn activity maps in.
  const steering: string[] = [];
  const followUp: string[] = [];

  let graph = store.currentGraph() ?? "";

  const harnesses = createHarnesses({
    pi,
    tools: options.tools,
    store,
    getGraph: () => graph,
    setGraph: (xml, reason, added) => {
      graph = xml;
      store.appendGraph(xml, reason, added);
    },
    takeSteering: () => steering.splice(0, steering.length),
    takeFollowUp: () => followUp.splice(0, followUp.length),
  });

  store.update((meta) => {
    meta.status = "running";
  });

  const result = await start({
    harnesses,
    name: store.id,
    variables: { prompt: options.prompt ?? "", project: options.project },
    onActivity: (activity) => {
      options.onProgress?.(`${activity.activityId}  ${activity.harness}  ${activity.result.summary}`);
    },
    onTokens: (tokens, visited) => {
      store.update((meta) => {
        meta.tokens = tokens;
        meta.visited = visited;
      });
    },
    onExpressionWarning: (warning) => {
      options.onProgress?.(`  FEEL warning: ${warning.message} in ${warning.expression}`);
    },
  });

  store.writeEngineState(result.state);
  store.update((meta) => {
    meta.status =
      result.outcome === "completed" ? "completed" : result.outcome === "error" ? "error" : "wait";
    // The token reports come from getPostponed() as the run proceeds, so the
    // last one seen is whatever was in flight at the time. A run that reached an
    // end event has no token anywhere; leaving the stale set behind would draw
    // one on the diagram forever.
    if (result.outcome === "completed") meta.tokens = [];
  });

  return {
    sessionId: store.id,
    outcome: result.outcome,
    turns: store.readMeta().turns.length,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}
