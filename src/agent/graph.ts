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
import { activityProperties, harnessOf, ioMapping, type ActivityLike } from "./zeebe.ts";
import { SUPPORTED_ELEMENT_TYPES, SUPPORTED_EVENT_DEFINITIONS } from "../js/lib/supported-bpmn-elements.ts";

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
    const outgoing = (start as unknown as { outgoing?: Array<{ targetRef?: ModdleFlowElement }> })?.outgoing;
    let target = outgoing?.[0]?.targetRef;
    // A plain merge gateway (fake-join's replacement -- see scripts/bpmn-tools.mjs)
    // is not a real "first stop": it exists only to make an implicit
    // multi-incoming merge explicit, and unconditionally forwards to whatever
    // is really first. Follow it (and any chain of them) rather than reporting
    // the gateway itself, the same way a human reading the diagram would.
    while (target?.$type === "bpmn:ExclusiveGateway" && (target.outgoing as unknown[] | undefined)?.length === 1) {
      target = (target.outgoing as Array<{ targetRef?: ModdleFlowElement }>)[0]?.targetRef;
    }
    if (target) return { id: target.id, type: target.$type };
  }
  return undefined;
}

export interface GraphOutlineState {
  visited?: readonly string[];
  tokens?: readonly string[];
}

/**
 * Renders a terminal-native flow outline walking the BPMN process sequence flows,
 * annotating visited elements (`·`), active tokens (`●`), gateway branches, and
 * loop back-edges (`↺`).
 */
export async function graphOutline(xml: string, state?: GraphOutlineState): Promise<string> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  const proc = executableProcess(rootElement);
  if (!proc) return "(no executable process found)";

  const flowElements = flattenFlowElements((proc.flowElements as ModdleFlowElement[]) ?? []);
  const nodesById = new Map<string, ModdleFlowElement>();
  const flowsBySource = new Map<string, Array<{ id: string; targetId: string; name?: string; condition?: string }>>();

  for (const el of flowElements) {
    if (el.$type === "bpmn:SequenceFlow") {
      const sourceId = (el.sourceRef as unknown as { id?: string })?.id ?? (el as unknown as { sourceRef?: string }).sourceRef;
      const targetId = (el.targetRef as unknown as { id?: string })?.id ?? (el as unknown as { targetRef?: string }).targetRef;
      if (sourceId && targetId) {
        const condition =
          (el.conditionExpression as unknown as { body?: string })?.body ??
          (typeof el.conditionExpression === "string" ? el.conditionExpression : undefined);
        const name = typeof el.name === "string" && el.name.trim() ? el.name.trim() : undefined;
        const list = flowsBySource.get(sourceId) ?? [];
        list.push({ id: el.id, targetId, name, condition });
        flowsBySource.set(sourceId, list);
      }
    } else {
      nodesById.set(el.id, el);
    }
  }

  const startEvent = flowElements.find((el) => el.$type === "bpmn:StartEvent");
  if (!startEvent) return "(no start event found)";

  const visitedTokens = new Set(state?.tokens ?? []);
  const visitedHistory = new Set(state?.visited ?? []);

  const lines: string[] = [];

  function nodeLabel(node: ModdleFlowElement): string {
    const harness = harnessOf({ id: node.id, type: node.$type, behaviour: node as unknown as ActivityLike["behaviour"] });
    const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : "";
    if (node.$type === "bpmn:StartEvent") return name ? `start (${name})` : `start`;
    if (node.$type === "bpmn:EndEvent") return name ? `◉ ${node.id} (${name})` : `◉ ${node.id}`;
    if (node.$type === "bpmn:ExclusiveGateway") return name ? `◆ ${node.id} (${name})` : `◆ ${node.id}`;
    if (node.$type === "bpmn:ParallelGateway") return name ? `✛ ${node.id} (${name})` : `✛ ${node.id}`;
    if (node.$type === "bpmn:UserTask") return `${node.id}  [UserTask${name ? `: ${name}` : ""}]`;
    if (node.$type === "bpmn:SubProcess") return `${node.id}  [SubProcess${name ? `: ${name}` : ""}]`;
    if (node.$type === "bpmn:CallActivity") {
      const called = (node as unknown as { calledElement?: string }).calledElement;
      return `${node.id}  [call: ${called ?? "unknown"}]`;
    }
    if (harness) return `${node.id}  ${harness}`;
    return name ? `${node.id} (${name})` : node.id;
  }

  function marker(nodeId: string): string {
    if (visitedTokens.has(nodeId)) return "●";
    if (visitedHistory.has(nodeId)) return "·";
    return " ";
  }

  function walk(nodeId: string, prefix: string, isTail: boolean, activePath: Set<string>): void {
    const node = nodesById.get(nodeId);
    if (!node) {
      lines.push(`${marker(nodeId)} ${prefix}${isTail ? "└─ " : "├─ "}? ${nodeId}`);
      return;
    }

    const mark = marker(node.id);
    const label = nodeLabel(node);
    const linePrefix = `${prefix}${isTail ? "└─ " : "├─ "}`;
    lines.push(`${mark} ${linePrefix}${label}`);

    if (activePath.has(nodeId)) {
      return;
    }

    const nextPath = new Set(activePath).add(nodeId);
    const flows = flowsBySource.get(nodeId) ?? [];
    if (flows.length === 0) return;

    const childPrefix = `${prefix}${isTail ? "   " : "│  "}`;

    if (flows.length === 1) {
      const targetId = flows[0]!.targetId;
      if (nextPath.has(targetId)) {
        const targetMark = marker(targetId);
        lines.push(`${targetMark} ${childPrefix}└─ ↺ ${targetId}`);
      } else {
        walk(targetId, childPrefix, true, nextPath);
      }
      return;
    }

    for (let i = 0; i < flows.length; i++) {
      const flow = flows[i]!;
      const isLastBranch = i === flows.length - 1;
      const branchLabel = flow.name ?? (flow.condition ? flow.condition.replace(/^=/, "") : undefined);
      const branchDesc = branchLabel ? `[${branchLabel}]` : `[branch ${i + 1}]`;

      const branchConnector = isLastBranch ? "└─ " : "├─ ";
      const branchChildPrefix = `${childPrefix}${isLastBranch ? "   " : "│  "}`;

      lines.push(`  ${childPrefix}${branchConnector}${branchDesc}`);

      if (nextPath.has(flow.targetId)) {
        const targetMark = marker(flow.targetId);
        lines.push(`${targetMark} ${branchChildPrefix}└─ ↺ ${flow.targetId}`);
      } else {
        walk(flow.targetId, branchChildPrefix, true, nextPath);
      }
    }
  }

  const startMark = marker(startEvent.id);
  lines.push(`${startMark} ${nodeLabel(startEvent)}`);
  const initialFlows = flowsBySource.get(startEvent.id) ?? [];
  if (initialFlows.length === 1) {
    walk(initialFlows[0]!.targetId, "", true, new Set([startEvent.id]));
  } else {
    for (let i = 0; i < initialFlows.length; i++) {
      const flow = initialFlows[i]!;
      const isTail = i === initialFlows.length - 1;
      walk(flow.targetId, "", isTail, new Set([startEvent.id]));
    }
  }

  return lines.join("\n");
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

/**
 * The op language `graph_architect` drafts instead of a whole document --
 * see `AGENT_ROLES.graph_architect` (`src/agent/harnesses.ts`) for the
 * prompt that documents these to the model, and the header comment on
 * `applyGraphOps` below for how each one maps onto bpmn-js's own Modeling
 * API primitives (`createShape`/`appendShape`/`insertShape`/`connect`).
 */
export type GraphOp =
  | { op: "createProcess"; id: string; name?: string }
  | {
      op: "appendShape";
      type: string;
      id: string;
      after: string;
      name?: string;
      process?: string;
      /** Only meaningful when `type` is `bpmn:CallActivity`. */
      calledElement?: string;
      /** One of SUPPORTED_EVENT_DEFINITIONS -- only meaningful on a start/end event. */
      eventDefinitionType?: string;
      /** ISO-8601 duration; only meaningful with eventDefinitionType "bpmn:TimerEventDefinition". */
      timerDuration?: string;
      /** Condition expression; meaningful with eventDefinitionType "bpmn:ConditionalEventDefinition". */
      condition?: string;
    }
  | {
      op: "insertShape";
      type: string;
      id: string;
      into: string;
      name?: string;
      process?: string;
      calledElement?: string;
      eventDefinitionType?: string;
      timerDuration?: string;
      condition?: string;
    }
  | { op: "connect"; from: string; to: string; id?: string; condition?: string; process?: string }
  | {
      op: "setTaskDefinition";
      id: string;
      jobType: string;
      headers?: Record<string, string>;
      inputs?: { source: string; target: string }[];
      outputs?: { source: string; target: string }[];
    }
  | { op: "setDocumentation"; id: string; text: string }
  | {
      /**
       * A boundary event doesn't fit appendShape (nothing "after" it -- it
       * isn't reached by a sequence flow at all) or insertShape (nothing to
       * split); it attaches to a host activity instead. Route where it goes
       * next with a separate "connect" op naming it as `from` -- this op
       * creates no sequence flow of its own.
       */
      op: "attachBoundaryEvent";
      id: string;
      attachedTo: string;
      eventDefinitionType: "bpmn:TimerEventDefinition" | "bpmn:ErrorEventDefinition" | "bpmn:ConditionalEventDefinition";
      /** Required with eventDefinitionType "bpmn:TimerEventDefinition". */
      timerDuration?: string;
      /** Required with eventDefinitionType "bpmn:ConditionalEventDefinition". */
      condition?: string;
      /** Interrupting (the host activity is cancelled when this fires) -- default true. */
      cancelActivity?: boolean;
      process?: string;
    };

/** Builds a `zeebe:ExtensionElements` value list the same shape every workflows/*.bpmn hand-writes. */
function zeebeTaskDefinitionValues(
  moddle: BpmnModdle,
  op: Extract<GraphOp, { op: "setTaskDefinition" }>,
): unknown[] {
  const values: unknown[] = [moddle.create("zeebe:TaskDefinition", { type: op.jobType })];
  if (op.headers && Object.keys(op.headers).length > 0) {
    values.push(
      moddle.create("zeebe:TaskHeaders", {
        values: Object.entries(op.headers).map(([key, value]) => moddle.create("zeebe:Header", { key, value })),
      }),
    );
  }
  if ((op.inputs?.length ?? 0) > 0 || (op.outputs?.length ?? 0) > 0) {
    values.push(
      moddle.create("zeebe:IoMapping", {
        inputParameters: (op.inputs ?? []).map((i) => moddle.create("zeebe:Input", { source: i.source, target: i.target })),
        outputParameters: (op.outputs ?? []).map((o) =>
          moddle.create("zeebe:Output", { source: o.source, target: o.target }),
        ),
      }),
    );
  }
  return values;
}

/** A boundary event only ever makes sense with an actual timeout, condition, or error to catch. */
const BOUNDARY_EVENT_DEFINITIONS: ReadonlySet<string> = new Set([
  "bpmn:TimerEventDefinition",
  "bpmn:ErrorEventDefinition",
  "bpmn:ConditionalEventDefinition",
]);

/**
 * Builds a `bpmn:TerminateEventDefinition`/`bpmn:TimerEventDefinition`/
 * `bpmn:ErrorEventDefinition`/`bpmn:ConditionalEventDefinition` moddle object
 * for an `eventDefinitionType` field on `appendShape`/`insertShape`/`attachBoundaryEvent`.
 * `allowed` lets `attachBoundaryEvent` restrict to Timer/Error/Conditional (Terminate makes
 * no sense on a boundary event) while `appendShape`/`insertShape` allow the
 * full `SUPPORTED_EVENT_DEFINITIONS` set.
 *
 * Zeebe expresses a timer's duration the plain-BPMN way -- a
 * `<bpmn:timeDuration>` child (`bpmn:FormalExpression`), not a `zeebe:`
 * extension (confirmed against `bpmn-elements`' own `TimerEventDefinition`,
 * which reads `behaviour.timeDuration` directly).
 */
function buildEventDefinition(
  moddle: BpmnModdle,
  type: string,
  timerDuration: string | undefined,
  condition: string | undefined,
  opIndex: number,
  allowed: ReadonlySet<string> = SUPPORTED_EVENT_DEFINITIONS,
): unknown {
  if (!allowed.has(type)) {
    const valid = [...allowed].sort().join(", ");
    throw new Error(`op ${opIndex}: event definition '${type}' is not supported here -- allowed: ${valid}`);
  }
  if (type === "bpmn:TimerEventDefinition") {
    if (!timerDuration) throw new Error(`op ${opIndex}: 'bpmn:TimerEventDefinition' needs a 'timerDuration'`);
    return moddle.create(type, { timeDuration: moddle.create("bpmn:FormalExpression", { body: timerDuration }) });
  }
  if (type === "bpmn:ConditionalEventDefinition") {
    if (!condition) throw new Error(`op ${opIndex}: 'bpmn:ConditionalEventDefinition' needs a 'condition'`);
    return moddle.create(type, { condition: moddle.create("bpmn:FormalExpression", { body: condition }) });
  }
  return moddle.create(type, {});
}

/**
 * Applies a small ops list to the current graph and returns the resulting
 * *complete* document -- headlessly mirroring what bpmn-js itself does live
 * in the editor when a person uses the palette to append or insert a shape.
 *
 * bpmn-js's `BpmnFactory.create()` (`bpmn-js/lib/features/modeling/BpmnFactory.js`)
 * is exactly `this._model.create(type, attrs)` -- a moddle object, nothing
 * more -- and `BpmnUpdater.updateSemanticParent`/`updateConnection`
 * (`bpmn-js/lib/features/modeling/BpmnUpdater.js`) wire it in by pushing that
 * object into the parent's `flowElements` array and assigning
 * `sourceRef`/`targetRef` by direct object reference, maintaining
 * `incoming`/`outgoing` alongside. Every op below does the same thing against
 * a parsed-but-not-live moddle tree instead of a rendered diagram.
 *
 * Every op only ever adds a moddle object, or (`insertShape`) retargets an
 * *existing* sequence flow's `targetRef` while keeping its id -- so the
 * "additive with stable ids" invariant `checkSplice` enforces holds by
 * construction, and nothing about `checkSplice`/`checkMigration` needs to
 * change to validate the result.
 */
export async function applyGraphOps(currentXml: string, ops: GraphOp[]): Promise<string> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement, elementsById } = await moddle.fromXML(currentXml.trim());
  const mainProcess = executableProcess(rootElement) as unknown as ModdleFlowElement | undefined;
  if (!mainProcess) throw new Error("current graph has no executable <bpmn:process>");

  const create = (type: string, attrs: Record<string, unknown> = {}): ModdleFlowElement =>
    moddle.create(type, attrs) as unknown as ModdleFlowElement;

  const processesById = new Map<string, ModdleFlowElement>([[mainProcess.id, mainProcess]]);
  const registry = new Map<string, ModdleFlowElement>(Object.entries(elementsById) as unknown as [string, ModdleFlowElement][]);

  const resolve = (id: string, opIndex: number): ModdleFlowElement => {
    const el = registry.get(id);
    if (!el) throw new Error(`op ${opIndex}: unknown element id '${id}'`);
    return el;
  };
  const processFor = (processId: string | undefined, opIndex: number): ModdleFlowElement => {
    if (!processId) return mainProcess;
    const process = processesById.get(processId);
    if (!process) throw new Error(`op ${opIndex}: unknown process '${processId}' -- add it first with "createProcess"`);
    return process;
  };
  /** The top-level `bpmn:Process` an already-existing element physically lives in, walking up `$parent`. */
  const ownerProcessOf = (el: ModdleFlowElement, opIndex: number): ModdleFlowElement => {
    let node: ModdleFlowElement | undefined = el;
    while (node && node.$type !== "bpmn:Process") {
      node = node.$parent as ModdleFlowElement | undefined;
    }
    if (!node) throw new Error(`op ${opIndex}: '${el.id}' is not inside any <bpmn:process>`);
    return node;
  };
  /**
   * Which process an op that wires into an *existing* element (`after`,
   * `into`, `from`, `attachedTo`) attaches into: an explicit `process` id if
   * given, otherwise wherever that target already lives -- never the
   * unconditional `mainProcess` default `processFor` alone would give an op
   * that never named one.
   *
   * `processFor(undefined, ...)` defaulting to `mainProcess` regardless of
   * the target is exactly how issue #94's splice slipped past
   * `checkProcessScope`: the *new* shape landed in the executable process
   * (so the added-ids check had nothing to object to) while the flow it
   * rewired stayed wired to elements that live in the *linked* process --
   * a `bpmn:SequenceFlow` split across two different `bpmn:Process`
   * containers, which is not valid BPMN and crashed the layout engine
   * instead of ever reaching review. An explicit `process` that disagrees
   * with where the target actually lives is rejected the same way, rather
   * than silently producing the same malformed cross-process document by a
   * different route.
   */
  const processForTarget = (processId: string | undefined, target: ModdleFlowElement, opIndex: number): ModdleFlowElement => {
    const owner = ownerProcessOf(target, opIndex);
    if (!processId) return owner;
    const named = processFor(processId, opIndex);
    if (named.id !== owner.id) {
      throw new Error(
        `op ${opIndex}: process '${processId}' does not match '${target.id}', which lives in '${owner.id}' -- ` +
          `a shape and the element it connects to must be in the same process`,
      );
    }
    return named;
  };
  const requireSupportedType = (type: string, opIndex: number): void => {
    if (!SUPPORTED_ELEMENT_TYPES.has(type)) {
      const valid = [...SUPPORTED_ELEMENT_TYPES].sort().join(", ");
      throw new Error(`op ${opIndex}: type '${type}' is not supported -- allowed types are: ${valid}`);
    }
  };
  const requireNewId = (id: string, opIndex: number): void => {
    if (registry.has(id)) throw new Error(`op ${opIndex}: id '${id}' already exists`);
  };
  const attach = (process: ModdleFlowElement, el: ModdleFlowElement): void => {
    const flowElements = (process.flowElements as ModdleFlowElement[] | undefined) ?? [];
    flowElements.push(el);
    process.flowElements = flowElements;
    el.$parent = process;
    registry.set(el.id, el);
  };
  let flowCounter = 0;
  const freshFlowId = (): string => {
    let id: string;
    do {
      flowCounter += 1;
      id = `Flow_ops_${flowCounter}`;
    } while (registry.has(id));
    return id;
  };
  const connectNodes = (
    process: ModdleFlowElement,
    source: ModdleFlowElement,
    target: ModdleFlowElement,
    id: string | undefined,
    extra: Record<string, unknown> = {},
  ): ModdleFlowElement => {
    const flow = create("bpmn:SequenceFlow", { id: id ?? freshFlowId(), sourceRef: source, targetRef: target, ...extra });
    attach(process, flow);
    const outgoing = (source.outgoing as ModdleFlowElement[] | undefined) ?? [];
    outgoing.push(flow);
    source.outgoing = outgoing;
    const incoming = (target.incoming as ModdleFlowElement[] | undefined) ?? [];
    incoming.push(flow);
    target.incoming = incoming;
    return flow;
  };

  ops.forEach((raw, opIndex) => {
    switch (raw.op) {
      case "createProcess": {
        requireNewId(raw.id, opIndex);
        const proc = create("bpmn:Process", { id: raw.id, name: raw.name, isExecutable: false, flowElements: [] });
        proc.$parent = rootElement;
        (rootElement.rootElements as unknown[]).push(proc);
        processesById.set(raw.id, proc);
        registry.set(raw.id, proc);
        break;
      }
      case "appendShape": {
        requireSupportedType(raw.type, opIndex);
        requireNewId(raw.id, opIndex);
        const source = resolve(raw.after, opIndex);
        const process = processForTarget(raw.process, source, opIndex);
        const shape = create(raw.type, {
          id: raw.id,
          name: raw.name,
          ...(raw.calledElement ? { calledElement: raw.calledElement } : {}),
          ...(raw.eventDefinitionType
            ? { eventDefinitions: [buildEventDefinition(moddle, raw.eventDefinitionType, raw.timerDuration, raw.condition, opIndex)] }
            : {}),
        });
        attach(process, shape);
        connectNodes(process, source, shape, undefined);
        break;
      }
      case "insertShape": {
        requireSupportedType(raw.type, opIndex);
        requireNewId(raw.id, opIndex);
        const flow = resolve(raw.into, opIndex);
        if (flow.$type !== "bpmn:SequenceFlow") throw new Error(`op ${opIndex}: '${raw.into}' is not a sequenceFlow`);
        const process = processForTarget(raw.process, flow, opIndex);
        const shape = create(raw.type, {
          id: raw.id,
          name: raw.name,
          ...(raw.calledElement ? { calledElement: raw.calledElement } : {}),
          ...(raw.eventDefinitionType
            ? { eventDefinitions: [buildEventDefinition(moddle, raw.eventDefinitionType, raw.timerDuration, raw.condition, opIndex)] }
            : {}),
        });
        attach(process, shape);
        const oldTarget = flow.targetRef as ModdleFlowElement;
        flow.targetRef = shape;
        const oldIncoming = (oldTarget.incoming as ModdleFlowElement[] | undefined) ?? [];
        const flowIndex = oldIncoming.indexOf(flow);
        if (flowIndex !== -1) oldIncoming.splice(flowIndex, 1);
        const shapeIncoming = (shape.incoming as ModdleFlowElement[] | undefined) ?? [];
        shapeIncoming.push(flow);
        shape.incoming = shapeIncoming;
        connectNodes(process, shape, oldTarget, undefined);
        break;
      }
      case "connect": {
        const source = resolve(raw.from, opIndex);
        const target = resolve(raw.to, opIndex);
        const process = processForTarget(raw.process, source, opIndex);
        const targetOwner = ownerProcessOf(target, opIndex);
        if (targetOwner.id !== process.id) {
          throw new Error(
            `op ${opIndex}: '${raw.from}' lives in '${process.id}' but '${raw.to}' lives in '${targetOwner.id}' -- ` +
              `a sequence flow cannot cross between processes`,
          );
        }
        if (raw.id) requireNewId(raw.id, opIndex);
        const extra: Record<string, unknown> = raw.condition
          ? { conditionExpression: create("bpmn:FormalExpression", { body: raw.condition }) }
          : {};
        connectNodes(process, source, target, raw.id, extra);
        break;
      }
      case "setTaskDefinition": {
        const el = resolve(raw.id, opIndex);
        const values = zeebeTaskDefinitionValues(moddle, raw);
        const existing = el.extensionElements as { values?: unknown[] } | undefined;
        if (existing) {
          existing.values = [...(existing.values ?? []), ...values];
        } else {
          el.extensionElements = create("bpmn:ExtensionElements", { values });
        }
        break;
      }
      case "setDocumentation": {
        const el = resolve(raw.id, opIndex);
        el.documentation = [create("bpmn:Documentation", { text: raw.text })];
        break;
      }
      case "attachBoundaryEvent": {
        requireSupportedType("bpmn:BoundaryEvent", opIndex);
        requireNewId(raw.id, opIndex);
        const host = resolve(raw.attachedTo, opIndex);
        const process = processForTarget(raw.process, host, opIndex);
        const eventDefinition = buildEventDefinition(
          moddle,
          raw.eventDefinitionType,
          raw.timerDuration,
          raw.condition,
          opIndex,
          BOUNDARY_EVENT_DEFINITIONS,
        );
        const shape = create("bpmn:BoundaryEvent", {
          id: raw.id,
          attachedToRef: host,
          cancelActivity: raw.cancelActivity ?? true,
          eventDefinitions: [eventDefinition],
        });
        // No sequence flow: a boundary event has no incoming flow (it attaches
        // via attachedToRef, not a flow) -- the model routes its outgoing path
        // with a separate "connect" op naming it as `from`.
        attach(process, shape);
        break;
      }
      default: {
        const unknownOp = raw as unknown as { op: string };
        throw new Error(`op ${opIndex}: unknown op '${unknownOp.op}'`);
      }
    }
  });

  const { xml } = await moddle.toXML(rootElement, { format: true });
  return xml;
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
 * A job type's I/O contract, in the same shape `HARNESS_IO`
 * (`src/agent/harnesses.ts`) declares it: which `zeebe:input` `target`s the
 * harness reads, which `zeebe:taskHeader`/`zeebe:properties` keys it reads,
 * and which `zeebe:output` `source`s it may name. Passed in by the caller
 * (`harnesses.ts`'s `graph:lint`/`graph:extend`, the studio's migration
 * guard) rather than imported directly, the same way `knownJobTypes` already
 * is -- `graph.ts` has no dependency on the harness registry, and importing
 * `HARNESS_IO` from `harnesses.ts` (which itself imports `checkSplice` from
 * here) would be circular. A caller that wants base result fields
 * (`status`, `summary`, ...) accepted as valid outputs folds them into
 * `outputs` itself before passing this in.
 */
export interface HarnessIOContract {
  inputs?: string[];
  headers?: string[];
  outputs?: string[];
}

/**
 * Rejects a *new* service task (one in `addedIds`) whose `zeebe:taskDefinition
 * type` names no harness in `knownJobTypes` -- or, when `harnessIO` names a
 * contract for that type, whose `zeebe:input`/`zeebe:taskHeaders`/
 * `zeebe:output` bindings do not match what the harness actually reads or
 * publishes. Shared by `checkSplice` and `checkMigration` -- both apply the
 * same contract, just to a different notion of "new".
 *
 * A registered-but-mis-wired type used to pass `checkSplice` outright: it
 * names a real harness, so the job-type check alone had nothing to object
 * to, and the mistake (`command` mapped through `zeebe:input` when `shell`
 * reads it from `zeebe:taskHeaders`, say) surfaced only the next time the
 * graph actually reached that activity -- by which point the session that
 * spliced it in could be long closed (issue #65; issue #40 closed the same
 * gap for the job type name itself).
 */
async function checkJobTypes(
  nextXml: string,
  addedIds: ReadonlySet<string>,
  knownJobTypes: ReadonlySet<string>,
  harnessIO?: Record<string, HarnessIOContract>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const task of await serviceTasks(nextXml)) {
    if (!addedIds.has(task.id)) continue;
    const jobType = harnessOf(task);
    if (jobType === undefined || !knownJobTypes.has(jobType)) {
      const valid = [...knownJobTypes].sort().join(", ");
      return {
        ok: false,
        reason:
          jobType === undefined
            ? `${task.id} has no zeebe:taskDefinition type; valid job types are: ${valid}`
            : `${task.id} names job type '${jobType}', which no harness handles; valid job types are: ${valid}`,
      };
    }

    const contract = harnessIO?.[jobType];
    if (!contract) continue;

    const mapping = ioMapping(task);
    for (const { target } of mapping.input) {
      if (target === undefined || (contract.inputs ?? []).includes(target)) continue;
      const valid = contract.inputs?.length
        ? `valid zeebe:input targets: ${contract.inputs.join(", ")}`
        : `'${jobType}' reads no zeebe:input at all`;
      return {
        ok: false,
        reason: `${task.id} maps input '${target}', which '${jobType}' never reads -- ${valid}`,
      };
    }

    for (const key of Object.keys(activityProperties(task))) {
      if ((contract.headers ?? []).includes(key)) continue;
      const valid = contract.headers?.length
        ? `valid zeebe:taskHeaders: ${contract.headers.join(", ")}`
        : `'${jobType}' reads no zeebe:taskHeaders at all`;
      return {
        ok: false,
        reason: `${task.id} sets header '${key}', which '${jobType}' never reads -- ${valid}`,
      };
    }

    for (const { source } of mapping.output) {
      // `source` is a FEEL expression -- normally a bare field reference
      // (`=exit_code`), but a graph is free to write a literal or a more
      // complex one (pi-default-loop.bpmn's `llm_turn` resets `prompt` to
      // `=null` once the seeded first turn has consumed it, deliberately not
      // reading anything off the harness result at all). Only a bare
      // identifier names a result field this check can actually verify;
      // anything else is a FEEL expression this has no business evaluating.
      const match = /^=(?!null$|true$|false$)([A-Za-z_][A-Za-z0-9_]*)$/.exec(source ?? "");
      const field = match?.[1];
      if (field === undefined || (contract.outputs ?? []).includes(field)) continue;
      const valid = contract.outputs?.length
        ? `valid outputs are: ${contract.outputs.join(", ")}`
        : `'${jobType}' publishes no outputs at all`;
      return {
        ok: false,
        reason: `${task.id} reads output '${field}', which '${jobType}' never publishes -- ${valid}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Rejects a *new* flow element (one in `addedIds`) whose `$type` isn't in
 * `allowedTypes` -- the same "only check what's genuinely new" shape
 * `checkJobTypes` already follows, applied to the element allowlist
 * (`src/js/lib/supported-bpmn-elements.ts`'s `SUPPORTED_ELEMENT_TYPES`)
 * instead of the job-type registry. Shared by `checkSplice`/`checkMigration`,
 * both via an optional trailing parameter -- omitting it leaves existing
 * callers unaffected, same convention as `knownJobTypes`/`harnessIO`.
 */
async function checkElementTypes(
  nextXml: string,
  addedIds: ReadonlySet<string>,
  allowedTypes: ReadonlySet<string>,
  allowedEventDefinitions?: ReadonlySet<string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(nextXml.trim());
  const processes = ((rootElement as unknown as { rootElements?: ModdleFlowElement[] }).rootElements ?? []).filter(
    (node) => node.$type === "bpmn:Process",
  );
  const all = processes.flatMap((process) => flattenFlowElements(process.flowElements));
  for (const el of all) {
    if (!addedIds.has(el.id)) continue;
    if (!allowedTypes.has(el.$type)) {
      const valid = [...allowedTypes].sort().join(", ");
      return {
        ok: false,
        reason: `${el.id} has type '${el.$type}', which is not supported -- allowed types are: ${valid}`,
      };
    }
    if (!allowedEventDefinitions) continue;
    for (const def of (el.eventDefinitions as ModdleFlowElement[] | undefined) ?? []) {
      if (allowedEventDefinitions.has(def.$type)) continue;
      const valid = [...allowedEventDefinitions].sort().join(", ");
      return {
        ok: false,
        reason: `${el.id} has event definition '${def.$type}', which is not supported -- allowed event definitions are: ${valid}`,
      };
    }
  }
  return { ok: true };
}

/** Which top-level `bpmn:Process` each flow element directly belongs to, and whether that process is executable. */
async function processOf(xml: string): Promise<Map<string, { id: string; isExecutable: boolean }>> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml.trim());
  const processes = ((rootElement as unknown as { rootElements?: ModdleFlowElement[] }).rootElements ?? []).filter(
    (node) => node.$type === "bpmn:Process",
  );
  const map = new Map<string, { id: string; isExecutable: boolean }>();
  for (const process of processes) {
    const info = {
      id: process.id,
      isExecutable: (process as unknown as { isExecutable?: boolean }).isExecutable !== false,
    };
    for (const el of flattenFlowElements(process.flowElements)) {
      map.set(el.id, info);
    }
  }
  return map;
}

/**
 * Rejects a *new* element (one in `addedIds`) that lands in a process
 * `linkGraph` marked `isExecutable="false"` -- one inlined from the graph
 * library via a `calledElement`, rather than the session's own process.
 *
 * `Definition.recover()` cannot replay a `bpmn:CallActivity`'s child process
 * once that child's own definition has changed underneath it: a splice into
 * the session's own (root, executable) process resumes cleanly, but the
 * exact same kind of splice into a linked process leaves the session
 * permanently stuck the moment the token reaches (or already occupies) it --
 * `note: the engine dispatched nothing at all within 5000ms ... this usually
 * means the resumed snapshot could not be recovered`, with no way back short
 * of abandoning the session (issue #86). `graph:lint` passing a splice is
 * supposed to mean it is wired correctly or rejected before it ever reaches
 * that state, the same way #40 and #65 already do for a job type invented or
 * wired wrong.
 */
async function checkProcessScope(
  nextXml: string,
  addedIds: ReadonlySet<string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const byId = await processOf(nextXml);
  for (const id of addedIds) {
    const info = byId.get(id);
    if (info && !info.isExecutable) {
      return {
        ok: false,
        reason:
          `${id} splices into '${info.id}', a linked process brought in by calledElement -- ` +
          `recovery cannot replay state there once that process's definition changes, so a splice into it ` +
          `leaves the session permanently stuck if the token ever reaches (or already occupies) it. Target the ` +
          `session's own process instead.`,
      };
    }
  }
  return { ok: true };
}

export async function checkSplice(
  previousXml: string,
  nextXml: string,
  knownJobTypes?: ReadonlySet<string>,
  harnessIO?: Record<string, HarnessIOContract>,
  allowedElementTypes?: ReadonlySet<string>,
  allowedEventDefinitions?: ReadonlySet<string>,
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
    const jobTypes = await checkJobTypes(nextXml, new Set(added), knownJobTypes, harnessIO);
    if (!jobTypes.ok) return { ok: false, added, removed, reason: jobTypes.reason };
  }
  if (allowedElementTypes) {
    const types = await checkElementTypes(nextXml, new Set(added), allowedElementTypes, allowedEventDefinitions);
    if (!types.ok) return { ok: false, added, removed, reason: types.reason };
  }
  const scope = await checkProcessScope(nextXml, new Set(added));
  if (!scope.ok) return { ok: false, added, removed, reason: scope.reason };
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
 * Element ids `Definition.recover()` would actually replay state for, read
 * straight from an engine snapshot rather than inferred from bookkeeping.
 *
 * `state.definitions[].execution.processes[]` holds one entry per process
 * instance bpmn-elements has ever instantiated for this run -- the top-level
 * one and any called process a `callActivity` has reached, per
 * `collectSharedOutput`'s own comment in `engine.ts`. A process that has
 * since completed (a lap's `craft_graph` invocation, once it returns) is
 * *not* removed from that array -- verified directly against a real
 * snapshot: it lingers with `execution.completed: true` and its usual
 * `execution.children`, rather than disappearing or clearing them out. Only
 * a process still short of that (still executing, still parked somewhere)
 * has genuinely recoverable state, so completed ones are skipped here. That
 * is exactly the set `checkMigration`'s `live` parameter should be: not
 * everything a session has *ever* touched (issue #70 found `meta.visited`,
 * made cumulative by issue #59, over-protects on that basis), but what
 * still has recoverable state right now.
 */
export function liveElementIds(state: EngineState): Set<string> {
  const ids = new Set<string>();
  const definitions = (state.definitions ?? []) as Array<{
    execution?: {
      processes?: Array<{ execution?: { completed?: boolean; children?: Array<{ id?: string }> } }>;
    };
  }>;
  for (const definition of definitions) {
    for (const process of definition.execution?.processes ?? []) {
      if (process.execution?.completed) continue;
      for (const child of process.execution?.children ?? []) {
        if (child.id) ids.add(child.id);
      }
    }
  }
  return ids;
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
 * `live` should be `liveElementIds(state) ∪ meta.tokens` -- the elements an
 * engine snapshot actually has recoverable state for, plus whatever the
 * live/in-memory token set has moved onto since the last snapshot was
 * written. `knownJobTypes`, when given, applies the same job-type contract
 * `checkSplice` does to any genuinely new activity. `<bpmn:definitions id>`
 * must also stay the same: `recoverWithGraph` throws on a mismatch, so this
 * rejects that explicitly rather than letting the next `resume` fail with a
 * less helpful error.
 */
export async function checkMigration(
  previousXml: string,
  nextXml: string,
  live: ReadonlySet<string>,
  knownJobTypes?: ReadonlySet<string>,
  harnessIO?: Record<string, HarnessIOContract>,
  allowedElementTypes?: ReadonlySet<string>,
  allowedEventDefinitions?: ReadonlySet<string>,
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

  const added = new Set([...after].filter((id) => !before.has(id)));

  if (knownJobTypes) {
    const jobTypes = await checkJobTypes(nextXml, added, knownJobTypes, harnessIO);
    if (!jobTypes.ok) return { ok: false, removed: [], reason: jobTypes.reason };
  }

  if (allowedElementTypes) {
    const types = await checkElementTypes(nextXml, added, allowedElementTypes, allowedEventDefinitions);
    if (!types.ok) return { ok: false, removed: [], reason: types.reason };
  }

  const scope = await checkProcessScope(nextXml, added);
  if (!scope.ok) return { ok: false, removed: [], reason: scope.reason };

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
