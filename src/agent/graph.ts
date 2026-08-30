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

/**
 * The activity a fresh run reaches first: the target of the start event's own
 * (first) outgoing sequence flow, in the first executable process. `cmdRun`
 * uses this to warn before a positional prompt is silently discarded on a
 * graph whose first stop is a human gate that never reads it -- issue #47
 * found `graph-agent run --graph session-skeleton "..."` accepts a prompt it
 * then never uses anywhere, since `await_intent` reads its own form instead.
 */
export async function firstActivity(xml: string): Promise<{ id: string; type: string } | undefined> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  const processes = (
    (rootElement as unknown as { rootElements?: ModdleFlowElement[] }).rootElements ?? []
  ).filter(
    (node) => node.$type === "bpmn:Process" && (node as unknown as { isExecutable?: boolean }).isExecutable !== false,
  );
  for (const process of processes) {
    const all = flattenFlowElements(process.flowElements);
    const start = all.find((node) => node.$type === "bpmn:StartEvent");
    const outgoing = (start as unknown as { outgoing?: Array<{ targetRef?: { id: string; $type: string } }> })
      ?.outgoing;
    const target = outgoing?.[0]?.targetRef;
    if (target) return { id: target.id, type: target.$type };
  }
  return undefined;
}

/**
 * Rewrites `<bpmn:definitions id>`. A session pins its definitions id for
 * recovery (`recoverWithGraph` throws on a mismatch), so a graph promoted out
 * of one (`graph-agent promote`, issue #55) needs its own before it can seed
 * a *different* session without colliding.
 */
export async function withDefinitionsId(xml: string, id: string): Promise<string> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  (rootElement as unknown as { id: string }).id = id;
  const { xml: serialized } = await moddle.toXML(rootElement, { format: true });
  return serialized;
}

/** The process a session actually runs, and the one `calledElement` should name -- `isExecutable="true"`. */
function executableProcess(
  rootElement: unknown,
): { $type: string; id: string; flowElements?: unknown[]; [key: string]: unknown } | undefined {
  const processes = (
    (rootElement as { rootElements?: Array<{ $type: string; [key: string]: unknown }> }).rootElements ?? []
  ).filter((el) => el.$type === "bpmn:Process") as Array<{ $type: string; id: string; [key: string]: unknown }>;
  return processes.find((el) => el.isExecutable !== false) ?? processes[0];
}

/**
 * Reads `<bpmn:process id>` for the executable process -- the id a
 * `calledElement` names to reach it, as distinct from `<bpmn:definitions id>`
 * (which recovery matches a session's snapshot on, not what `calledElement`
 * ever refers to).
 */
export async function processId(xml: string): Promise<string | undefined> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  return executableProcess(rootElement)?.id;
}

/**
 * Rewrites `<bpmn:process id>` for the executable process, and every
 * self-referential `calledElement` naming it. `calledElement` is a plain
 * string attribute, not a reference moddle resolves by object identity the
 * way `bpmndi:BPMNPlane`'s `bpmnElement` is -- serializing the diagram back
 * out already picks up a changed process id there for free, but a
 * self-recursive `callActivity` needs updating by hand.
 *
 * A graph promoted out of a session (`graph-agent promote`, issue #55) kept
 * the session's own process id, so promoting two sessions produced two
 * library files both defining the same process -- `calledElement` names a
 * *process*, not a file, and `indexLibrary` resolves it with last-write-wins,
 * so which of them a `callActivity` actually reaches became a function of
 * directory order rather than of what the user asked for (issue #64).
 */
export async function withProcessId(xml: string, id: string): Promise<string> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  const process = executableProcess(rootElement);
  if (!process) throw new Error("no executable <bpmn:process> to rename");
  const oldId = process.id;
  process.id = id;
  for (const element of flattenFlowElements((process.flowElements ?? []) as ModdleFlowElement[])) {
    if (element.$type === "bpmn:CallActivity" && element.calledElement === oldId) {
      element.calledElement = id;
    }
  }
  const { xml: serialized } = await moddle.toXML(rootElement, { format: true });
  return serialized;
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
/**
 * Rejects a *new* service task (one in `addedIds`) whose `zeebe:taskDefinition
 * type` names no harness in `knownJobTypes`. Shared by `checkSplice` and
 * `checkMigration` -- both apply the same job-type contract, just to a
 * different notion of "new".
 */
async function checkJobTypes(
  nextXml: string,
  addedIds: ReadonlySet<string>,
  knownJobTypes: ReadonlySet<string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const task of await serviceTasks(nextXml)) {
    if (!addedIds.has(task.id)) continue;
    const jobType = harnessOf(task);
    if (jobType !== undefined && knownJobTypes.has(jobType)) continue;
    const valid = [...knownJobTypes].sort().join(", ");
    return {
      ok: false,
      reason:
        jobType === undefined
          ? `${task.id} has no zeebe:taskDefinition type; valid job types are: ${valid}`
          : `${task.id} names job type '${jobType}', which no harness handles; valid job types are: ${valid}`,
    };
  }
  return { ok: true };
}

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
    const jobTypes = await checkJobTypes(nextXml, new Set(added), knownJobTypes);
    if (!jobTypes.ok) return { ok: false, added, removed, reason: jobTypes.reason };
  }
  return { ok: true, added, removed };
}

/** The `<bpmn:definitions id>` of a graph. */
export async function definitionsId(xml: string): Promise<string> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  return String((rootElement as unknown as { id: string }).id);
}

export interface MigrationCheck {
  ok: boolean;
  removed: string[];
  reason?: string;
}

/**
 * A looser sibling of `checkSplice`, for a human edit rather than a drafted
 * splice: the vision only requires that *the parts currently being executed*
 * survive, not that the whole graph is additive. A human may delete an
 * element the token has never reached; deleting or renaming one that carries
 * live state is still rejected, because `Definition.recover()` replays child
 * state by element id the same way regardless of who made the edit
 * (issue #46).
 *
 * `live` is `meta.visited ∪ meta.tokens` -- every id the session has ever
 * stood on or currently stands on. `knownJobTypes`, when given, applies the
 * same job-type contract `checkSplice` does to any genuinely new activity.
 * `<bpmn:definitions id>` must also stay the same: `recoverWithGraph` throws
 * on a mismatch, so this rejects that explicitly rather than letting the
 * next `resume` fail with a less helpful error.
 */
export async function checkMigration(
  previousXml: string,
  nextXml: string,
  live: ReadonlySet<string>,
  knownJobTypes?: ReadonlySet<string>,
): Promise<MigrationCheck> {
  if ((await definitionsId(previousXml)) !== (await definitionsId(nextXml))) {
    return {
      ok: false,
      removed: [],
      reason:
        "<bpmn:definitions id> must not change -- recovery matches a snapshot to a graph on that id, and " +
        "recoverWithGraph refuses a mismatch",
    };
  }

  const before = await elementIds(previousXml);
  const after = await elementIds(nextXml);
  const removedLive = [...before].filter((id) => !after.has(id) && live.has(id));
  if (removedLive.length > 0) {
    return {
      ok: false,
      removed: removedLive,
      reason: `these elements have live state and cannot be removed or renamed: ${removedLive.join(", ")}`,
    };
  }

  if (knownJobTypes) {
    const added = new Set([...after].filter((id) => !before.has(id)));
    const jobTypes = await checkJobTypes(nextXml, added, knownJobTypes);
    if (!jobTypes.ok) return { ok: false, removed: [], reason: jobTypes.reason };
  }

  return { ok: true, removed: [] };
}

export interface PendingGate {
  id: string;
  name?: string;
  documentation?: string;
  /** The `zeebe:userTaskForm` a `bpmn:UserTask`'s `zeebe:formDefinition formId` names, if it resolves to one. */
  form?: { formId: string; schema: string };
}

/**
 * The parked human gates among `tokenIds` (`meta.tokens`), each with enough
 * to render a form for it: the activity's own name/documentation, and the
 * `zeebe:userTaskForm` schema its `zeebe:formDefinition` names -- forms live
 * on the *process's* `extensionElements`, keyed by id, not on the task itself
 * (`session-skeleton.bpmn`'s `session_intent_form`, e.g.). Used by the
 * studio's `GET /api/sessions/:id/pending` (issue #51); a non-`bpmn:UserTask`
 * token (a service task mid-turn, say) is not a gate and is left out.
 */
export async function pendingGates(xml: string, tokenIds: readonly string[]): Promise<PendingGate[]> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  const processes = ((rootElement as unknown as { rootElements?: ModdleFlowElement[] }).rootElements ?? []).filter(
    (node) => node.$type === "bpmn:Process",
  );

  const forms = new Map<string, string>();
  for (const process of processes) {
    const values =
      (process as unknown as { extensionElements?: { values?: Array<Record<string, unknown>> } }).extensionElements
        ?.values ?? [];
    for (const value of values) {
      if (value.$type === "zeebe:UserTaskForm" && typeof value.id === "string" && typeof value.body === "string") {
        forms.set(value.id, value.body);
      }
    }
  }

  const byId = new Map(processes.flatMap((process) => flattenFlowElements(process.flowElements)).map((el) => [el.id, el]));
  const wanted = new Set(tokenIds);
  const gates: PendingGate[] = [];
  for (const id of wanted) {
    const el = byId.get(id);
    if (!el || el.$type !== "bpmn:UserTask") continue;
    const docs = (el as unknown as { documentation?: Array<{ text?: string }> }).documentation ?? [];
    const extValues =
      (el as unknown as { extensionElements?: { values?: Array<Record<string, unknown>> } }).extensionElements
        ?.values ?? [];
    const formDef = extValues.find((value) => value.$type === "zeebe:FormDefinition") as
      | { formId?: string }
      | undefined;
    const schema = formDef?.formId !== undefined ? forms.get(formDef.formId) : undefined;

    gates.push({
      id,
      ...(typeof el.name === "string" ? { name: el.name } : {}),
      ...(docs[0]?.text !== undefined ? { documentation: docs[0].text } : {}),
      ...(formDef?.formId !== undefined && schema !== undefined ? { form: { formId: formDef.formId, schema } } : {}),
    });
  }
  return gates;
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
