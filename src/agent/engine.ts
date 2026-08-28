/**
 * The bpmn-engine host.
 *
 * BPMN owns the control flow: the token moves, and each activity that declares a
 * `harness` in `camunda:properties` dispatches to the matching implementation.
 * Nothing here loops -- the loop, when there is one, is drawn in the diagram.
 */
import { Engine } from "bpmn-engine";
import { EventEmitter } from "node:events";
import {
  activityProperties,
  applyZeebeLoop,
  harnessOf,
  ioMapping,
  resolveInput,
  resolveOutput,
  retriesOf,
  type ActivityLike,
} from "./zeebe.ts";
import { camundaExpressions, evaluateFeel } from "./expressions.ts";
import {
  MODDLE_OPTIONS,
  recoverWithGraph,
  toSourceContext,
  type EngineConstructor,
  type EngineInstance,
  type EngineState,
} from "./graph.ts";
import type { HarnessContext, HarnessRegistry, HarnessResult } from "./harness.ts";

const EngineCtor = Engine as unknown as EngineConstructor;

export interface ActivityOutcome {
  activityId: string;
  activityName?: string;
  harness: string;
  result: HarnessResult;
  startedAt: number;
  endedAt: number;
}

export interface RunnerOptions {
  harnesses: HarnessRegistry;
  variables?: Record<string, unknown>;
  name?: string;
  signal?: AbortSignal;
  /** Called after each harness-backed activity completes. */
  onActivity?: (outcome: ActivityOutcome) => void | Promise<void>;
  /** Called whenever the token moves, with the ids currently waiting. */
  onTokens?: (tokens: string[], visited: string[]) => void | Promise<void>;
  /**
   * Called when an activity parks -- a user task, a receive task, an
   * intermediate catch event. Return a payload to answer it and let the token
   * carry on; return undefined to leave it parked.
   *
   * This is the seam a human gate lives behind, and the one an `agent:tool`
   * activity uses: the tool call parks the token until its result arrives.
   */
  onWait?: (activityId: string) => Promise<unknown> | unknown;
  /**
   * When an activity parks unanswered, stop the engine and snapshot rather than
   * hanging. Defaults to true: parking is how a graph asks for something the
   * engine cannot supply on its own, and the caller decides what happens next.
   */
  stopOnWait?: boolean;
  /**
   * FEEL evaluation warnings, chiefly "Variable 'x' not found". FEEL is total,
   * so a misspelled gateway condition silently takes the wrong branch unless
   * someone looks at these.
   */
  onExpressionWarning?: (warning: { expression: string; message: string }) => void;
}

export interface RunResult {
  /** `completed` when the process reached an end event, `stopped` otherwise. */
  outcome: "completed" | "stopped" | "error";
  state: EngineState;
  variables: Record<string, unknown>;
  activities: ActivityOutcome[];
  error?: Error;
}

/**
 * Install harness dispatch on an activity.
 *
 * bpmn-engine has no notion of `camunda:properties`, so this is where a diagram's
 * `harness` declaration turns into an actual call. Modelled on paed01's
 * "Extend service task behaviour" example.
 */
/**
 * zeebe:ioMapping sources are FEEL. The mapping module stays pure and takes an
 * evaluator, so this is where it is supplied: a flat scope, since the source is
 * evaluated against process variables (input) or the job result (output).
 */
const feelIn = (expression: string, scope: Record<string, unknown>): unknown =>
  evaluateFeel(expression, { environment: { variables: scope, output: {} }, content: {} });

/**
 * Retries a harness call on a thrown/rejected error only -- a job failure in C8
 * terms. A harness that *returns* `status: "failed"` is a business error the
 * graph routes on with a gateway, and retrying it would just run it again
 * unconditionally; that path is untouched.
 */
async function callWithRetries(call: () => Promise<HarnessResult>, attempts: number): Promise<HarnessResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

type RegisteredActivity = ActivityLike & Record<string, unknown>;

function makeExtension(options: RunnerOptions, activities: ActivityOutcome[], byId: Map<string, RegisteredActivity>) {
  return function harnessExtension(activity: RegisteredActivity): void {
    // Multi-instance activities carry their collection in a zeebe: extension the
    // engine does not read; translate it before anything tries to run the loop.
    applyZeebeLoop(activity);
    // Recorded for every activity, harness-backed or not: a userTask has no
    // Service to hook zeebe:ioMapping through, so `drive()`'s activity.end
    // listener applies its output mapping directly, and needs the definition.
    byId.set(activity.id, activity);

    const harnessName = harnessOf(activity);
    if (!harnessName) return;

    const implementation = options.harnesses[harnessName];
    const properties = activityProperties(activity);
    // zeebe:taskDefinition retries="n" is a count of attempts, not extra retries
    // on top of the first: no attribute (or retries="0") means the current
    // one-shot behaviour, retries="3" means up to three tries before giving up.
    const attempts = Math.max(1, retriesOf(activity) ?? 1);

    const environment = (activity as unknown as { environment: { variables: Record<string, unknown>; output: Record<string, unknown> } })
      .environment;

    activity.behaviour.Service = function HarnessService() {
      return {
        type: `${activity.type}:harness`,
        execute(
          executionMessage: { content?: Record<string, unknown> },
          callback: (error: Error | null, result?: unknown) => void,
        ): void {
          const startedAt = Date.now();
          const variables = { ...environment.variables };
          if (!implementation) {
            callback(new Error(`no harness registered for '${harnessName}' (activity ${activity.id})`));
            return;
          }

          const context: HarnessContext = {
            activityId: activity.id,
            ...(activity.name === undefined ? {} : { activityName: activity.name }),
            harness: harnessName,
            properties,
            input: resolveInput(
              activity,
              { ...variables, ...environment.output, ...(executionMessage.content ?? {}) },
              feelIn,
            ),
            variables: { ...variables, ...environment.output },
            ...(options.signal ? { signal: options.signal } : {}),
          };

          void callWithRetries(() => implementation(context), attempts).then(
            (result) => {
              // Publish camunda:outputParameter / camunda:resultVariable before the
              // token leaves, so the next gateway sees the values.
              //
              // It has to go to `environment.output`, not `environment.variables`:
              // Environment.clone() copies `variables` by value, so every activity
              // gets its own snapshot and a write there is invisible to the rest of
              // the run. `output` is passed through by reference and is shared.
              for (const [key, value] of Object.entries(resolveOutput(activity, result, feelIn))) {
                if (value !== undefined) environment.output[key] = value;
              }
              activities.push({
                activityId: activity.id,
                ...(activity.name === undefined ? {} : { activityName: activity.name }),
                harness: harnessName,
                result,
                startedAt,
                endedAt: Date.now(),
              });
              void options.onActivity?.(activities[activities.length - 1] as ActivityOutcome);
              callback(null, result);
            },
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
          );
        },
      };
    };
  };
}

function engineOptions(
  options: RunnerOptions,
  activities: ActivityOutcome[],
  byId: Map<string, RegisteredActivity>,
): Record<string, unknown> {
  return {
    name: options.name ?? "graph-agent",
    moddleOptions: MODDLE_OPTIONS,
    variables: options.variables ?? {},
    // Gateways in Camunda-flavoured diagrams compare values; the default
    // handler only does truthy lookups. See src/agent/expressions.ts.
    expressions: camundaExpressions(
      options.onExpressionWarning ? { onWarning: options.onExpressionWarning } : {},
    ),
    extensions: { harness: makeExtension(options, activities, byId) },
  };
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/** Answer a parked activity by looking up a live api for it. */
function signalPostponed(engine: EngineInstance, activityId: string, message: unknown): void {
  const postponed = (engine.execution?.getPostponed() ?? []) as Array<{
    id: string;
    signal?: (message?: unknown) => void;
  }>;
  const target = postponed.find((activity) => activity.id === activityId);
  if (target?.signal) target.signal(message);
}

/**
 * Applies `zeebe:ioMapping` output for an activity the harness Service wrapper
 * never touched -- a `zeebe:userTask`, chiefly. bpmn-engine has no notion of
 * Camunda IO outside that wrapper, so a user task's answered form (the
 * `output` bpmn-elements attaches to its `activity.end` content) would
 * otherwise never become a named process variable: `session-skeleton.bpmn`'s
 * `await_intent` publishes `session_done` this way, and without it `gw_more`
 * never sees a true `session_done` and loops forever.
 */
function applyUnharnessedOutput(activity: RegisteredActivity | undefined, signaled: unknown): void {
  if (!activity || harnessOf(activity)) return;
  const outputs = ioMapping(activity).output;
  if (outputs.length === 0) return;
  const scope = signaled && typeof signaled === "object" ? signaled : {};
  const environment = (activity as unknown as { environment: { output: Record<string, unknown> } }).environment;
  for (const [key, value] of Object.entries(resolveOutput(activity, scope, feelIn))) {
    if (value !== undefined) environment.output[key] = value;
  }
}

/** Ids the token is currently resting on (waiting activities and running ones). */
export function postponedIds(engine: EngineInstance): string[] {
  try {
    return (engine.execution?.getPostponed() ?? []).map((p) => p.id);
  } catch {
    return [];
  }
}

async function drive(
  engine: EngineInstance,
  options: RunnerOptions,
  activities: ActivityOutcome[],
  byId: Map<string, RegisteredActivity>,
  start: (listener: EventEmitter) => Promise<unknown>,
): Promise<RunResult> {
  const visited = new Set<string>();
  const listener = new EventEmitter();

  listener.on("activity.end", (api: { id: string; content?: { output?: unknown } }) => {
    visited.add(api.id);
    applyUnharnessedOutput(byId.get(api.id), api.content?.output);
    void options.onTokens?.(postponedIds(engine), [...visited]);
  });
  listener.on("activity.wait", (api: { id: string; signal?: (message?: unknown) => void }) => {
    void options.onTokens?.(postponedIds(engine), [...visited]);

    const answer = options.onWait?.(api.id);

    // The api handed to a listener is only good for the duration of that event.
    // A synchronous answer can use it directly; anything awaited has to re-acquire
    // a live api from the postponed set, or the signal lands on a stale one and
    // the activity simply never wakes up.
    if (answer !== undefined && !isPromise(answer)) {
      api.signal?.(answer);
      return;
    }
    if (answer === undefined) {
      if (options.stopOnWait !== false) void engine.stop();
      return;
    }

    void answer.then((resolved) => {
      if (resolved === undefined) {
        if (options.stopOnWait !== false) void engine.stop();
        return;
      }
      signalPostponed(engine, api.id, resolved);
    });
  });

  const ended = engine.waitFor("end").then(() => "completed" as const);
  const stopped = engine.waitFor("stop").then(() => "stopped" as const);
  const errored = engine.waitFor("error").then((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });

  if (options.signal) {
    options.signal.addEventListener("abort", () => void engine.stop(), { once: true });
  }

  try {
    await start(listener);
    const outcome = await Promise.race([ended, stopped, errored]);
    return {
      outcome,
      state: await engine.getState(),
      variables: { ...engine.environment.variables, ...engine.environment.output },
      activities,
    };
  } catch (error) {
    return {
      outcome: "error",
      state: await engine.getState(),
      variables: { ...engine.environment.variables, ...engine.environment.output },
      activities,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Start a fresh process instance from BPMN XML. */
export async function runGraph(xml: string, options: RunnerOptions): Promise<RunResult> {
  const activities: ActivityOutcome[] = [];
  const byId = new Map<string, RegisteredActivity>();
  const sourceContext = await toSourceContext(xml);
  const engine = new EngineCtor({ ...engineOptions(options, activities, byId), sourceContext });
  return drive(engine, options, activities, byId, (listener) => engine.execute({ listener }));
}

/**
 * Resume a snapshot, optionally against a graph that has since been extended.
 * This is how a session picks up after a splice.
 */
export async function resumeGraph(state: EngineState, xml: string, options: RunnerOptions): Promise<RunResult> {
  const activities: ActivityOutcome[] = [];
  const byId = new Map<string, RegisteredActivity>();
  const engine = await recoverWithGraph(EngineCtor, state, xml, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.variables ? { variables: options.variables } : {}),
    engineOptions: engineOptions(options, activities, byId),
  });
  return drive(engine, options, activities, byId, (listener) => engine.resume({ listener }));
}
