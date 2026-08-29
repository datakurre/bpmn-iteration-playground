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
import { indexLibrary, linkGraph } from "./link.ts";
import { bundledWorkflowsDir, listBpmnFiles } from "./paths.ts";
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
  /**
   * Called when the graph parks on a human gate -- a user task, a receive task.
   * Return a payload to answer it and let the run continue, or undefined to stop
   * with a snapshot so it can be resumed once someone answers.
   */
  onWait?: (activityId: string) => Promise<unknown> | unknown;
  /** Aborting stops the engine -- a snapshot is still saved, so `resume` picks up from there. */
  signal?: AbortSignal;
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

/**
 * Whether a graph has an `agent:tool` activity anywhere -- the only thing
 * that can actually run a tool call an `agent:turn` model asks for. A cheap
 * substring check rather than a parse: `zeebe:taskDefinition` always writes
 * its job type as a quoted attribute (`type="agent:tool"`), and a false
 * positive here only costs offering a tool that then goes unused, not a wedged
 * run -- the failure mode this exists to avoid only comes from the opposite,
 * a false *negative*, which a literal match on the attribute does not produce.
 */
export function graphOffersTools(xml: string): boolean {
  return xml.includes('type="agent:tool"');
}

export async function runSession(options: RunSessionOptions): Promise<SessionOutcome> {
  const sessionId = options.sessionId ?? randomUUID().slice(0, 8);
  const store = new SessionStore(options.paths, sessionId);
  if (!store.exists()) store.create(options.project, options.name);

  // Resolve callActivity targets from the shared library before the session owns
  // the graph: bpmn-elements only finds a called process inside the same
  // definition. Revision 0 is therefore the linked graph, which is what makes the
  // session self-contained and its recovery safe.
  const source = readFileSync(options.graphPath, "utf8");
  const linked = await linkGraph(source, await libraryIndex(options.paths));
  for (const target of linked.dynamic) {
    options.onProgress?.(`  note: calledElement '${target}' is an expression and cannot be linked ahead of the run`);
  }
  const reason =
    linked.linked.length > 0
      ? `started from ${options.graphPath}, linked ${linked.linked.join(", ")}`
      : `started from ${options.graphPath}`;
  store.appendGraph(linked.xml, reason, []);

  return drive(store, options, (harnessOptions) => runGraph(store.currentGraph() ?? linked.xml, harnessOptions));
}

/**
 * The graphs a session may call: the user's library, with the bundled graphs
 * behind it so a user copy shadows a built-in of the same process id.
 */
async function libraryIndex(paths: Paths) {
  const files = [...listBpmnFiles(bundledWorkflowsDir()), ...listBpmnFiles(paths.workflowsDir)].map((file) => ({
    source: file.path,
    xml: readFileSync(file.path, "utf8"),
  }));
  return indexLibrary(files);
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
  let graph = store.currentGraph() ?? "";

  // agent:tool is what actually runs a tool call the model asks for; a graph
  // with no such activity anywhere has nowhere to send one. Pi's tool list is
  // fixed for the whole session -- its prompt cache covers it, and changing
  // tools mid-session would invalidate every turn's cache -- so this is
  // decided once, up front, rather than per turn: a graph like craft-graph's
  // draft_fragment otherwise offers the model four tools it can never
  // actually run, and the model reaching for one wedges the run one activity
  // downstream of the real cause, surfacing as "a turn is already in flight"
  // on the *next* turn rather than naming the stuck call (issue #36). With no
  // tools declared, Pi's request carries none at all, so the model has
  // nothing to call in the first place -- this holds for the rest of the
  // session even if a later splice adds an agent:tool activity, since the
  // tool list itself cannot change without the same cache cost.
  const canRunTools = graphOffersTools(graph);

  const pi = new PiSession({
    model: options.model,
    systemPrompt: options.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    tools: canRunTools ? options.tools.list() : [],
    streamFn: options.streamFn,
    sessionId: store.id,
  });

  // Steering and follow-up arrive from outside the graph; the graph decides when
  // to drain them. The initial prompt is not one of these -- it enters as a
  // process variable that the turn activity maps in.
  const steering: string[] = [];
  const followUp: string[] = [];

  const harnesses = createHarnesses({
    pi,
    tools: options.tools,
    store,
    cwd: options.project,
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
    ...(options.onWait === undefined ? {} : { onWait: options.onWait }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onExpressionWarning: (warning) => {
      options.onProgress?.(`  FEEL warning: ${warning.message} in ${warning.expression}`);
    },
  });

  // bpmn-engine reports "completed" for any run that reaches an end event, even
  // pi-default-loop's own error path: end_error is a plain terminate end event,
  // not a thrown error, so a turn that errored looks exactly like one that
  // finished cleanly unless something checks. A *graph* is free to route a
  // failed() harness result anywhere it likes (craft-graph's lint_exhausted ->
  // craft_rejected is a legitimate, non-error outcome), so this deliberately
  // does not treat every failed() activity in the run as trouble -- only the
  // last turn actually reaching Pi, since that is what end_error's own
  // condition (`stop_reason = "error"`) keys on.
  const meta = store.readMeta();
  const lastTurn = meta.turns.at(-1);
  const trouble = result.outcome === "completed" && lastTurn?.stopReason === "error" ? lastTurn : undefined;
  const outcome = trouble ? "error" : result.outcome;
  // Prefer `result.error`'s own message, but a harness that gave up outside
  // the ordinary turn path (graph:lint's redraft-attempt cap, chiefly) may
  // have already recorded a clearer one in meta.harnessError: bpmn-elements
  // re-wraps a thrown error at every callActivity boundary it crosses, and by
  // the time it reaches here `result.error.message` can be empty even though
  // the original cause is well known.
  const fallbackMessage =
    meta.harnessError ?? trouble?.error ?? lastTurn?.error ?? `${lastTurn?.activityId ?? "run"} stopped: error`;
  const error =
    outcome !== "error" ? undefined : result.error?.message ? result.error : new Error(fallbackMessage);

  store.writeEngineState(result.state);
  store.update((meta) => {
    meta.status = outcome === "completed" ? "completed" : outcome === "error" ? "error" : "wait";
    // The token reports come from getPostponed() as the run proceeds, so the
    // last one seen is whatever was in flight at the time. A run that reached an
    // end event has no token anywhere; leaving the stale set behind would draw
    // one on the diagram forever.
    if (outcome === "completed") meta.tokens = [];
  });

  return {
    sessionId: store.id,
    outcome,
    turns: store.readMeta().turns.length,
    ...(error === undefined ? {} : { error }),
  };
}
