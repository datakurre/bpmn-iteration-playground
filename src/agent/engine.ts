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
  camundaProperties,
  harnessOf,
  resolveInput,
  resolveOutput,
  type ActivityLike,
} from "./camunda7.ts";
import { camundaExpressions } from "./expressions.ts";
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
function makeExtension(options: RunnerOptions, activities: ActivityOutcome[]) {
  return function harnessExtension(activity: ActivityLike & Record<string, unknown>): void {
    const harnessName = harnessOf(activity);
    if (!harnessName) return;

    const implementation = options.harnesses[harnessName];
    const properties = camundaProperties(activity);
    delete properties.harness;
    delete properties.harness_type;

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
            input: resolveInput(activity, {
              ...variables,
              ...environment.output,
              ...(executionMessage.content ?? {}),
            }),
            variables: { ...variables, ...environment.output },
            ...(options.signal ? { signal: options.signal } : {}),
          };

          void implementation(context).then(
            (result) => {
              // Publish camunda:outputParameter / camunda:resultVariable before the
              // token leaves, so the next gateway sees the values.
              //
              // It has to go to `environment.output`, not `environment.variables`:
              // Environment.clone() copies `variables` by value, so every activity
              // gets its own snapshot and a write there is invisible to the rest of
              // the run. `output` is passed through by reference and is shared.
              for (const [key, value] of Object.entries(resolveOutput(activity, result))) {
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

function engineOptions(options: RunnerOptions, activities: ActivityOutcome[]): Record<string, unknown> {
  return {
    name: options.name ?? "graph-agent",
    moddleOptions: MODDLE_OPTIONS,
    variables: options.variables ?? {},
    // Gateways in Camunda-flavoured diagrams compare values; the default
    // handler only does truthy lookups. See src/agent/expressions.ts.
    expressions: camundaExpressions(
      options.onExpressionWarning ? { onWarning: options.onExpressionWarning } : {},
    ),
    extensions: { harness: makeExtension(options, activities) },
  };
}

/** Ids the token is currently resting on (waiting activities and running ones). */
export function postponedIds(engine: EngineInstance): string[] {
  try {
    return (engine.execution?.getPostponed() ?? []).map((p) => p.id);
  } catch {
    return [];
  }
}

async function drive(engine: EngineInstance, options: RunnerOptions, activities: ActivityOutcome[], start: (listener: EventEmitter) => Promise<unknown>): Promise<RunResult> {
  const visited = new Set<string>();
  const listener = new EventEmitter();

  listener.on("activity.end", (api: { id: string }) => {
    visited.add(api.id);
    void options.onTokens?.(postponedIds(engine), [...visited]);
  });
  listener.on("activity.wait", (api: { id: string }) => {
    void options.onTokens?.(postponedIds(engine), [...visited]);
    void (async () => {
      const answer = await options.onWait?.(api.id);
      if (answer !== undefined) {
        engine.execution?.signal({ id: api.id, ...(answer as Record<string, unknown>) });
        return;
      }
      if (options.stopOnWait !== false) void engine.stop();
    })();
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
  const sourceContext = await toSourceContext(xml);
  const engine = new EngineCtor({ ...engineOptions(options, activities), sourceContext });
  return drive(engine, options, activities, (listener) => engine.execute({ listener }));
}

/**
 * Resume a snapshot, optionally against a graph that has since been extended.
 * This is how a session picks up after a splice.
 */
export async function resumeGraph(state: EngineState, xml: string, options: RunnerOptions): Promise<RunResult> {
  const activities: ActivityOutcome[] = [];
  const engine = await recoverWithGraph(EngineCtor, state, xml, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.variables ? { variables: options.variables } : {}),
    engineOptions: engineOptions(options, activities),
  });
  return drive(engine, options, activities, (listener) => engine.resume({ listener }));
}
