/**
 * Resolving `callActivity` across BPMN files.
 *
 * bpmn-elements resolves `calledElement` only within the same definition: if the
 * target process is not there, the call emits `activity.call` and waits forever
 * for a signal. But graphs in the shared library are separate files, and a
 * session graph should be able to say "run the crafting flow here" without
 * anyone copying it by hand.
 *
 * So the library is *linked* into the session's definition when the session
 * starts, and the linked graph is what gets stored as revision 0. The session
 * keeps owning a self-contained, mutable graph -- splices still work, and
 * recovery still replays child state by element id against a graph the session
 * owns -- while authors write a plain `calledElement="craft_graph"`.
 *
 * A session therefore pins the library version it started with. Editing a
 * library graph does not reach into a running session, which is the right
 * default: it is what makes recovery safe.
 */
import { BpmnModdle } from "bpmn-moddle";
import { MODDLE_OPTIONS } from "./graph.ts";

interface ModdleElement {
  $type: string;
  id?: string;
  [key: string]: unknown;
}

interface Definitions extends ModdleElement {
  rootElements?: ModdleElement[];
  diagrams?: ModdleElement[];
}

/** Where a called process can be found: process id -> the file's BPMN XML. */
export type LibraryIndex = Map<string, { source: string; xml: string }>;

export interface LinkResult {
  xml: string;
  /** Process ids linked in, in the order they were resolved. */
  linked: string[];
  /**
   * `calledElement` values that are FEEL expressions rather than literal process
   * ids. These cannot be resolved before the run, so they are left alone.
   */
  dynamic: string[];
}

export class LinkError extends Error {}

function moddle(): BpmnModdle {
  return new BpmnModdle(MODDLE_OPTIONS);
}

/** Every element id in a definitions tree, so collisions can be caught. */
function collectIds(node: unknown, into: Set<string>): Set<string> {
  if (!node || typeof node !== "object") return into;
  const record = node as Record<string, unknown>;
  if (typeof record.id === "string") into.add(record.id);
  for (const key of ["rootElements", "flowElements", "artifacts", "lanes", "childLaneSet"]) {
    const child = record[key];
    if (Array.isArray(child)) for (const item of child) collectIds(item, into);
  }
  return into;
}

function processes(definitions: Definitions): ModdleElement[] {
  return (definitions.rootElements ?? []).filter((e) => e.$type === "bpmn:Process");
}

/** `calledElement` values of every call activity in a definitions tree. */
export function calledElements(definitions: Definitions): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.$type === "bpmn:CallActivity" && typeof record.calledElement === "string") {
      found.push(record.calledElement);
    }
    for (const key of ["rootElements", "flowElements", "artifacts"]) {
      const child = record[key];
      if (Array.isArray(child)) for (const item of child) visit(item);
    }
  };
  visit(definitions);
  return found;
}

/** Camunda 8 writes an expression with a leading `=`; those cannot be linked. */
function isDynamic(calledElement: string): boolean {
  return calledElement.trimStart().startsWith("=") || calledElement.includes("${");
}

/**
 * Index the graphs a session may call, by the id of the process inside them.
 *
 * `calledElement` names a *process*, not a file, so `craft_graph` has to find
 * `craft-graph.bpmn`. Later sources shadow earlier ones, so pass the bundled
 * graphs first and the user's library second.
 */
export async function indexLibrary(files: Array<{ source: string; xml: string }>): Promise<LibraryIndex> {
  const index: LibraryIndex = new Map();
  for (const file of files) {
    let definitions: Definitions;
    try {
      definitions = (await moddle().fromXML(file.xml)).rootElement as unknown as Definitions;
    } catch {
      // A library file that does not parse should not stop a session starting;
      // it simply cannot be called.
      continue;
    }
    for (const process of processes(definitions)) {
      if (process.id) index.set(process.id, file);
    }
  }
  return index;
}

/**
 * Append every called process into `xml`, transitively.
 *
 * Linked processes are marked `isExecutable="false"`. This is not cosmetic: a
 * linked-in process left executable is auto-started as a top-level process *as
 * well as* being called, so its body runs twice. Marking it non-executable keeps
 * it callable and stops it being a root.
 */
export async function linkGraph(xml: string, index: LibraryIndex): Promise<LinkResult> {
  const parsed = await moddle().fromXML(xml);
  const definitions = parsed.rootElement as unknown as Definitions;

  const linked: string[] = [];
  const dynamic: string[] = [];
  const present = new Set(processes(definitions).map((p) => p.id).filter((id): id is string => Boolean(id)));
  const ids = collectIds(definitions, new Set<string>());

  // Breadth-first over call activities, so a called graph's own calls resolve too.
  const pending = [...calledElements(definitions)];
  const seen = new Set<string>();


  while (pending.length > 0) {
    const target = pending.shift() as string;

    if (isDynamic(target)) {
      if (!dynamic.includes(target)) dynamic.push(target);
      continue;
    }
    // Each process is linked at most once, so a call graph that loops back --
    // A calls B calls A -- links fine and terminates: the second call simply
    // finds A already present. Whether such a graph *recurses forever at
    // runtime* is a modelling question the engine answers, not a link error.
    if (present.has(target) || seen.has(target)) continue;
    seen.add(target);

    const file = index.get(target);
    if (!file) {
      throw new LinkError(
        `no graph in the library defines a process '${target}', called by a callActivity. ` +
          `Add it to the graph library, or correct the calledElement.`,
      );
    }

    const calleeDefinitions = (await moddle().fromXML(file.xml)).rootElement as unknown as Definitions;
    const process = processes(calleeDefinitions).find((p) => p.id === target);
    if (!process) throw new LinkError(`'${file.source}' does not define a process '${target}'`);

    const calleeIds = collectIds(process, new Set<string>());
    const collisions = [...calleeIds].filter((id) => ids.has(id));
    if (collisions.length > 0) {
      throw new LinkError(
        `linking '${target}' from '${file.source}' would duplicate element id(s) ${collisions.join(", ")}. ` +
          `Recovery replays state by element id, so ids must be unique across a linked graph.`,
      );
    }

    // Callable, but not a root. See the note above.
    process.isExecutable = false;
    (process as { $parent?: unknown }).$parent = definitions;
    definitions.rootElements = [...(definitions.rootElements ?? []), process];

    // Bring the callee's diagram across so the studio can render it if asked.
    const plane = (calleeDefinitions.diagrams ?? []).find(
      (diagram) =>
        ((diagram as { plane?: { bpmnElement?: { id?: string } } }).plane?.bpmnElement?.id ?? "") === target,
    );
    if (plane) {
      (plane as { $parent?: unknown }).$parent = definitions;
      definitions.diagrams = [...(definitions.diagrams ?? []), plane];
    }

    for (const id of calleeIds) ids.add(id);
    present.add(target);
    linked.push(target);
    pending.push(...calledElements(process as unknown as Definitions));
  }

  if (linked.length === 0) return { xml, linked, dynamic };

  const { xml: serialized } = await moddle().toXML(definitions, { format: true });
  return { xml: serialized, linked, dynamic };
}
