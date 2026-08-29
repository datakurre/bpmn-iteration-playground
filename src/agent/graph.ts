/**
 * Loading, snapshotting and *mutating* a running BPMN definition.
 *
 * The session graph is not fixed: the agent splices new nodes into it while it
 * runs. bpmn-engine supports that, but only via one specific sequence, and the
 * obvious spelling of it silently fails -- see `recoverWithGraph`.
 */
import { BpmnModdle } from "bpmn-moddle";
import * as elements from "bpmn-elements";
import { Serializer, TypeResolver } from "moddle-context-serializer";
import zeebeDescriptor from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };
import { harnessOf, type ActivityLike } from "./zeebe.ts";

export const MODDLE_OPTIONS = { zeebe: zeebeDescriptor };

// bpmn-elements exports a few event-definition objects that do not satisfy
// TypeResolver's `NewableFunction` index signature, though the resolver accepts
// them at runtime. The cast keeps the call honest without loosening the module.
const types = TypeResolver({ ...elements } as unknown as Record<string, CallableFunction>);

export interface SourceContext {
  id: string;
  [key: string]: unknown;
}

/**
 * Parse BPMN XML into the serialized context bpmn-engine consumes.
 *
 * Producing this eagerly (rather than passing `source:` to the Engine) is what
 * makes in-flight graph replacement work; `recoverWithGraph` explains why.
 */
export async function toSourceContext(xml: string): Promise<SourceContext> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const moddleContext = await moddle.fromXML(xml.trim());
  return Serializer(moddleContext as never, types as never) as unknown as SourceContext;
}

/** Definition-level state as stored inside an engine snapshot. */
interface DefinitionState {
  id: string;
  source?: string;
  [key: string]: unknown;
}

export interface EngineState {
  definitions?: DefinitionState[];
  [key: string]: unknown;
}

/**
 * Strip the definition source embedded in a snapshot.
 *
 * `Execution.getState()` always serialises the current source into the snapshot,
 * and `Engine.recover()` prefers that embedded copy over anything the engine was
 * constructed with. Removing it is what lets a *different* graph be supplied on
 * recovery -- which is the whole point of a mutable session graph.
 */
export function stripEmbeddedSource(state: EngineState): EngineState {
  const definitions = (state.definitions ?? []).map(({ source: _source, ...rest }) => rest);
  return { ...state, definitions };
}

/** Ids of every flow element in a graph, by element id. */
export async function elementIds(xml: string): Promise<Set<string>> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.id === "string") ids.add(record.id);
    for (const key of ["rootElements", "flowElements", "artifacts", "childLaneSet", "lanes"]) {
      const child = record[key];
      if (Array.isArray(child)) for (const item of child) visit(item);
    }
  };
  visit(rootElement);
  return ids;
}

export interface SpliceCheck {
  ok: boolean;
  added: string[];
  removed: string[];
  reason?: string;
}

interface ModdleFlowElement {
  $type: string;
  id: string;
  flowElements?: ModdleFlowElement[];
  [key: string]: unknown;
}

function flattenFlowElements(nodes: ModdleFlowElement[] = []): ModdleFlowElement[] {
  return nodes.flatMap((node) => [node, ...flattenFlowElements(node.flowElements)]);
}

/**
 * Every `bpmn:ServiceTask` in a graph, adapted to the `{ id, type, behaviour }`
 * shape `harnessOf` (written against the running engine's own activities)
 * expects -- see workflows.test.ts's `asActivity` for the same adaptation.
 */
async function serviceTasks(xml: string): Promise<ActivityLike[]> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  const processes = ((rootElement as unknown as { rootElements?: ModdleFlowElement[] }).rootElements ?? []).filter(
    (node) => node.$type === "bpmn:Process",
  );
  const all = processes.flatMap((process) => flattenFlowElements(process.flowElements));
  return all
    .filter((node) => node.$type === "bpmn:ServiceTask")
    .map((node) => ({ id: node.id, type: node.$type, behaviour: node as unknown as ActivityLike["behaviour"] }));
}

/**
 * Graph mutation has to be additive with stable ids.
 *
 * `Definition.recover()` replays child state *by element id*. An element that
 * carried live state and then disappears -- or gets renumbered -- leaves the
 * recovered definition referring to something that no longer exists. Adding
 * nodes and re-pointing sequence flows is safe; removing or renaming is not.
 *
 * `knownJobTypes`, when given, also rejects a *new* service task whose
 * `zeebe:taskDefinition type` names no registered harness. Without this, a
 * drafted fragment that invents a plausible-looking job type (`shell:exec`
 * instead of `shell`, say) passes as a perfectly additive splice, gets
 * approved and committed, and only dies the next time the graph actually
 * reaches that activity -- by which point the session that produced it is
 * long closed (issue #40). Only *new* activities are checked: an existing
 * one already ran once as part of a graph someone approved, and revalidating
 * it here would reject a splice for a job type problem that predates it.
 */
export async function checkSplice(
  previousXml: string,
  nextXml: string,
  knownJobTypes?: ReadonlySet<string>,
): Promise<SpliceCheck> {
  const before = await elementIds(previousXml);
  const after = await elementIds(nextXml);
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  if (removed.length > 0) {
    return {
      ok: false,
      added,
      removed,
      reason: `graph mutation must be additive; these elements were removed or renamed: ${removed.join(", ")}`,
    };
  }
  if (knownJobTypes) {
    const addedIds = new Set(added);
    for (const task of await serviceTasks(nextXml)) {
      if (!addedIds.has(task.id)) continue;
      const jobType = harnessOf(task);
      if (jobType !== undefined && knownJobTypes.has(jobType)) continue;
      const valid = [...knownJobTypes].sort().join(", ");
      return {
        ok: false,
        added,
        removed,
        reason:
          jobType === undefined
            ? `${task.id} has no zeebe:taskDefinition type; valid job types are: ${valid}`
            : `${task.id} names job type '${jobType}', which no harness handles; valid job types are: ${valid}`,
      };
    }
  }
  return { ok: true, added, removed };
}

export interface RecoverOptions {
  /** Harness implementations, exposed to the graph as `environment.services`. */
  services?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  name?: string;
  /** Merged into the Engine constructor options (extensions, listener, ...). */
  engineOptions?: Record<string, unknown>;
}

/**
 * Rebuild an engine from a snapshot, optionally against a *replacement* graph.
 *
 * The `sourceContext` (not `source`) spelling is load-bearing. `Engine.recover()`
 * is synchronous, while the `source:` option is stored as an unresolved Promise;
 * the fallback that matches a pre-loaded source to a saved definition does
 * `preSources.find(s => s.id === dState.id)`, which cannot match a Promise and
 * dies with "Cannot read properties of undefined (reading 'id')". Passing an
 * already-resolved sourceContext is what makes the lookup succeed.
 *
 * `<definitions id="...">` must therefore stay stable across revisions: it is the
 * id the snapshot is matched on.
 */
export async function recoverWithGraph(
  Engine: EngineConstructor,
  state: EngineState,
  xml: string,
  options: RecoverOptions = {},
): Promise<EngineInstance> {
  const sourceContext = await toSourceContext(xml);
  const stripped = stripEmbeddedSource(state);

  const savedId = stripped.definitions?.[0]?.id;
  if (savedId !== undefined && savedId !== sourceContext.id) {
    throw new Error(
      `cannot recover: snapshot definition id '${savedId}' does not match the graph's '${sourceContext.id}'. ` +
        `The <definitions id> must stay stable across graph revisions.`,
    );
  }

  const engine = new Engine({
    moddleOptions: MODDLE_OPTIONS,
    ...options.engineOptions,
    name: options.name ?? "graph-agent",
    sourceContext,
    ...(options.services ? { services: options.services } : {}),
    ...(options.variables ? { variables: options.variables } : {}),
  });
  engine.recover(stripped);
  return engine;
}

// bpmn-engine's shipped types describe the Engine loosely; these are the members
// this project actually depends on.
export interface EngineInstance {
  name?: string;
  execute(options?: Record<string, unknown>): Promise<unknown>;
  resume(options?: Record<string, unknown>): Promise<unknown>;
  recover(state: unknown, options?: unknown): EngineInstance;
  stop(): Promise<unknown> | unknown;
  getState(): Promise<EngineState>;
  waitFor(event: string): Promise<unknown>;
  broker: unknown;
  execution?: {
    signal(message: unknown, options?: unknown): void;
    getPostponed(): Array<{ id: string; type: string; content?: unknown }>;
    getActivityById(id: string): unknown;
  };
  environment: { variables: Record<string, unknown>; output: Record<string, unknown> };
  activityStatus?: string;
}

export type EngineConstructor = new (options: Record<string, unknown>) => EngineInstance;
