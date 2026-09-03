/**
 * Custom Planar BPMN Auto-Layout Engine.
 *
 * Implements a modular grid-based layout algorithm tailored to graph-agent's
 * Camunda 8 BPMN workflows.
 *
 * Principles:
 * - Primary horizontal spine centered at Y=70.
 * - Modular 150px column grid: col 0 at centerX=75, col 1 at 225, col 2 at 375, etc.
 * - Multi-track vertical lanes (Track 0 at Y=70, Track 1 at Y=210, Track 2 at Y=490).
 * - Planar, zero-crossing orthogonal routing with dedicated return/bypass channels
 *   (Channel 1 at Y=140, Channel 2 at Y=280, Channel 3 at Y=560).
 * - Full support for expanded SubProcesses and their internal elements.
 * - Automatic generation of BPMNLabel bounds (width 90, height 20) for all named
 *   events and gateways, satisfying bpmnlint's local/label-layout rule.
 */
import { BpmnModdle } from "bpmn-moddle";
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };

export interface AutoLayoutOptions {
  colWidth?: number;
  spineY?: number;
  track1Y?: number;
  track2Y?: number;
  trackGap?: number;
  channel1Y?: number;
  channel2Y?: number;
  channel3Y?: number;
}

const DEFAULT_OPTIONS: Required<AutoLayoutOptions> = {
  colWidth: 150,
  spineY: 70,
  track1Y: 210,
  track2Y: 490,
  trackGap: 140,
  channel1Y: 140,
  channel2Y: 280,
  channel3Y: 560,
};

interface ElementDimensions {
  width: number;
  height: number;
}

function getElementDimensions(element: any): ElementDimensions {
  const type = element.$type || "";
  if (type.endsWith("Event")) return { width: 36, height: 36 };
  if (type.endsWith("Gateway")) return { width: 50, height: 50 };
  if (type === "bpmn:SubProcess") return { width: 360, height: 200 };
  return { width: 100, height: 80 };
}

interface NodeLayout {
  id: string;
  element: any;
  col: number;
  track: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  isSubProcessChild?: boolean;
}

interface ProcessLayoutResult {
  nodes: Map<string, NodeLayout>;
  allFlows: any[];
}

/**
 * A `bpmn:SequenceFlow` whose `sourceRef`/`targetRef` belong to two
 * different top-level `bpmn:Process` elements is not valid BPMN -- a flow
 * can only connect elements within the process (or nested subprocess) that
 * owns it. Left undetected, this used to surface as a bare `Cannot read
 * properties of undefined (reading '$type')` deep in track/waypoint
 * computation, which named neither the flow nor why it was malformed
 * (issue #94). `applyGraphOps`/`checkSplice` (graph.ts) now refuse to
 * produce this shape in the first place, but a hand-written or
 * externally-supplied document could still reach here, so this names the
 * problem up front rather than crashing partway through layout.
 */
function assertNoCrossProcessFlows(processes: any[]): void {
  const processIdOf = new Map<string, string>();
  const flattenIds = (nodes: any[], processId: string): void => {
    for (const node of nodes) {
      processIdOf.set(node.id, processId);
      if (node.flowElements) flattenIds(node.flowElements, processId);
    }
  };
  for (const process of processes) {
    flattenIds(process.flowElements || [], process.id);
  }
  for (const process of processes) {
    for (const flow of flattenFlowsOf(process.flowElements || [])) {
      const srcProcess = flow.sourceRef && processIdOf.get(flow.sourceRef.id);
      const tgtProcess = flow.targetRef && processIdOf.get(flow.targetRef.id);
      if (srcProcess && srcProcess !== process.id) {
        throw new Error(
          `${flow.id} belongs to process '${process.id}' but its source '${flow.sourceRef.id}' lives in '${srcProcess}' -- a sequence flow cannot cross between processes`,
        );
      }
      if (tgtProcess && tgtProcess !== process.id) {
        throw new Error(
          `${flow.id} belongs to process '${process.id}' but its target '${flow.targetRef.id}' lives in '${tgtProcess}' -- a sequence flow cannot cross between processes`,
        );
      }
    }
  }
}

function flattenFlowsOf(nodes: any[]): any[] {
  return nodes.flatMap((node) => [
    ...(node.$type === "bpmn:SequenceFlow" ? [node] : []),
    ...(node.flowElements ? flattenFlowsOf(node.flowElements) : []),
  ]);
}

export async function layoutProcess(xml: string, options: AutoLayoutOptions = {}): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const moddle = new BpmnModdle({ zeebe });
  const { rootElement } = await moddle.fromXML(xml);
  const root = rootElement as any;

  const processes = (root.rootElements || []).filter((el: any) => el.$type === "bpmn:Process");
  if (processes.length === 0) return xml;

  assertNoCrossProcessFlows(processes);

  // Clean existing diagrams
  root.diagrams = [];

  for (const process of processes) {
    const layout = computeProcessLayout(process, opts);
    createProcessDi(moddle, root, process, layout, opts);
  }

  const { xml: outputXml } = await moddle.toXML(rootElement, { format: true });
  return outputXml;
}

function computeProcessLayout(process: any, opts: Required<AutoLayoutOptions>): ProcessLayoutResult {
  const allFlowElements: any[] = process.flowElements || [];
  const topNodes = allFlowElements.filter((el) => el.$type !== "bpmn:SequenceFlow");
  const topFlows = allFlowElements.filter((el) => el.$type === "bpmn:SequenceFlow");

  const nodesById = new Map<string, any>(topNodes.map((n) => [n.id, n]));
  const incomingFlows = new Map<string, any[]>();
  const outgoingFlows = new Map<string, any[]>();

  for (const node of topNodes) {
    incomingFlows.set(node.id, []);
    outgoingFlows.set(node.id, []);
  }

  for (const flow of topFlows) {
    const src = flow.sourceRef?.id;
    const tgt = flow.targetRef?.id;
    if (src && nodesById.has(src)) outgoingFlows.get(src)!.push(flow);
    if (tgt && nodesById.has(tgt)) incomingFlows.get(tgt)!.push(flow);
  }

  // 1. Detect back-edges (cycles / loop-backs) via DFS
  const startEvent = topNodes.find((n) => n.$type === "bpmn:StartEvent") || topNodes[0];
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const backEdges = new Set<string>(); // flow IDs

  function dfsDetectBackEdges(nodeId: string) {
    visited.add(nodeId);
    onStack.add(nodeId);

    for (const flow of outgoingFlows.get(nodeId) || []) {
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;

      if (onStack.has(targetId)) {
        backEdges.add(flow.id);
      } else if (!visited.has(targetId)) {
        dfsDetectBackEdges(targetId);
      }
    }

    onStack.delete(nodeId);
  }

  if (startEvent) dfsDetectBackEdges(startEvent.id);

  // 2. Identify the Primary Spine (Track 0)
  // Score paths from startEvent to find the main activity-rich path
  function countActivitiesAlongPath(nodeId: string, seen: Set<string>): number {
    if (seen.has(nodeId)) return 0;
    seen.add(nodeId);
    const node = nodesById.get(nodeId);
    let count = 0;
    if (node && (node.$type.endsWith("Task") || node.$type === "bpmn:CallActivity" || node.$type === "bpmn:SubProcess")) {
      count = 1;
    }

    let maxSub = 0;
    for (const flow of outgoingFlows.get(nodeId) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (targetId && nodesById.has(targetId)) {
        maxSub = Math.max(maxSub, countActivitiesAlongPath(targetId, new Set(seen)));
      }
    }
    return count + maxSub;
  }

  function flowSpineScore(flow: any, fromNodeId: string): number {
    const targetId = flow.targetRef?.id;
    const targetNode = nodesById.get(targetId);
    if (!targetNode) return -100;
    if (targetNode.$type === "bpmn:SubProcess") return -50;
    if (flow.name === "no" || flow.name === "reject" || flow.name === "give up") return -50;
    if (flow.name?.toLowerCase().includes("error") || flow.name?.toLowerCase().includes("fail")) return -50;

    // Prefer non-error EndEvents for the horizontal happy path on Track 0
    if (targetNode.$type.endsWith("EndEvent")) {
      return 100;
    }

    // If target has an immediate back-edge loop, rank lower than a process completion exit
    const hasBackEdge = (outgoingFlows.get(targetId) || []).some((f) => backEdges.has(f.id));
    if (hasBackEdge) {
      return 10;
    }

    return 50;
  }

  const spineNodeIds: string[] = [];
  const spineSet = new Set<string>();
  let curr = startEvent?.id;

  while (curr && !spineSet.has(curr)) {
    spineSet.add(curr);
    spineNodeIds.push(curr);

    const outs = (outgoingFlows.get(curr) || []).filter((f) => !backEdges.has(f.id));
    if (outs.length === 0) break;

    if (outs.length === 1) {
      curr = outs[0].targetRef?.id;
      continue;
    }

    // Multiple forward branches at gateway: pick the highest-scoring one (see
    // flowSpineScore -- an immediate error/failure exit scores low even though it
    // targets an EndEvent, so the real continuation branch still wins).
    const sortedOuts = [...outs].sort((a, b) => flowSpineScore(b, curr!) - flowSpineScore(a, curr!));
    const bestFlow = sortedOuts[0] || outs[0];
    curr = bestFlow.targetRef?.id;
  }

  // 3. Track and Column Assignment
  const nodeTrack = new Map<string, number>();
  const nodeCol = new Map<string, number>();

  // General automated track & column placement: walk the primary spine at track 0,
  // then breadth-first place every branch relative to its parent's column/track.
  let col = 0;
  for (const id of spineNodeIds) {
    nodeTrack.set(id, 0);
    nodeCol.set(id, col);
    const node = nodesById.get(id);
    const dim = getElementDimensions(node);
    const span = Math.max(1, Math.ceil(dim.width / opts.colWidth));
    col += span;
  }

  const queue = [...spineNodeIds];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const parentCol = nodeCol.get(parentId)!;
    const parentTrack = nodeTrack.get(parentId)!;
    const parentNode = nodesById.get(parentId);
    const parentDim = getElementDimensions(parentNode);
    const parentSpan = Math.max(1, Math.ceil(parentDim.width / opts.colWidth));

    for (const flow of outgoingFlows.get(parentId) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;

      if (!nodeTrack.has(targetId)) {
        let targetTrack = parentTrack;
        if (spineSet.has(parentId) && !spineSet.has(targetId)) {
          // Check if there is a branch spanned by a back-edge loop on the lower track
          // "session skeleton still fails to use upper gateway routes to avoid lane collision"
          const isSpannedByBackEdge = Array.from(backEdges).some((bId) => {
            const bFlow = topFlows.find((f) => f.id === bId);
            if (!bFlow) return false;
            const bSrcCol = nodeCol.get(bFlow.sourceRef?.id);
            const bTgtCol = nodeCol.get(bFlow.targetRef?.id);
            if (bSrcCol !== undefined && bTgtCol !== undefined) {
              return bTgtCol <= parentCol && parentCol <= bSrcCol;
            }
            return false;
          });

          targetTrack = isSpannedByBackEdge ? -1 : parentTrack + 1;
        }

        nodeTrack.set(targetId, targetTrack);
        const targetCol = Math.max(parentCol + parentSpan, nodeCol.get(targetId) ?? 0);
        nodeCol.set(targetId, targetCol);
        queue.push(targetId);
      } else {
        const minCol = parentCol + parentSpan;
        if (nodeCol.get(targetId)! < minCol) {
          shiftNodeAndDescendants(targetId, minCol);
        }
      }
    }
  }

  function shiftNodeAndDescendants(id: string, newCol: number) {
    const oldCol = nodeCol.get(id) || 0;
    if (newCol <= oldCol) return;
    nodeCol.set(id, newCol);
    const dim = getElementDimensions(nodesById.get(id));
    const span = Math.max(1, Math.ceil(dim.width / opts.colWidth));

    for (const flow of outgoingFlows.get(id) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (targetId && nodeCol.has(targetId)) {
        shiftNodeAndDescendants(targetId, newCol + span);
      }
    }
  }

  // Handle any orphan nodes
  let maxCol = Math.max(0, ...Array.from(nodeCol.values()));
  for (const node of topNodes) {
    if (!nodeCol.has(node.id)) {
      maxCol += 1;
      nodeCol.set(node.id, maxCol);
      nodeTrack.set(node.id, 0);
    }
  }

  // Prevent overlap on same track. Columns represent element *centers*, so compare
  // actual half-widths in column units rather than assuming each node occupies a
  // left-anchored integer span (that assumption under-reserves space for anything
  // wider than one column pitch, e.g. an expanded SubProcess).
  const tracksUsed = new Set(nodeTrack.values());
  for (const t of tracksUsed) {
    const nodesOnTrack = topNodes
      .filter((n) => nodeTrack.get(n.id) === t)
      .sort((a, b) => nodeCol.get(a.id)! - nodeCol.get(b.id)!);

    const colGap = 0.4;
    let lastRightEdge = -Infinity;
    for (const n of nodesOnTrack) {
      const dim = getElementDimensions(n);
      const halfSpan = dim.width / opts.colWidth / 2;
      let currentCol = nodeCol.get(n.id)!;
      if (currentCol - halfSpan < lastRightEdge + colGap) {
        const neededCol = Math.ceil(lastRightEdge + colGap + halfSpan);
        if (neededCol > currentCol) {
          shiftNodeAndDescendants(n.id, neededCol);
          currentCol = neededCol;
        }
      }
      lastRightEdge = currentCol + halfSpan;
    }
  }

  // Horizontally align terminal end events across different tracks when unobstructed
  // "end events should be horizontally aligned when it does not cause additional node or lane collisions."
  const endEvents = topNodes.filter((n) => n.$type.endsWith("EndEvent"));
  if (endEvents.length > 1) {
    const maxEndCol = Math.max(...endEvents.map((n) => nodeCol.get(n.id) ?? 0));
    for (const endNode of endEvents) {
      const currentCol = nodeCol.get(endNode.id) ?? 0;
      if (currentCol < maxEndCol) {
        const track = nodeTrack.get(endNode.id) ?? 0;
        const hasObstacle = topNodes.some(
          (n) => n.id !== endNode.id && nodeTrack.get(n.id) === track && (nodeCol.get(n.id) ?? 0) >= currentCol && (nodeCol.get(n.id) ?? 0) <= maxEndCol,
        );
        if (!hasObstacle) {
          nodeCol.set(endNode.id, maxEndCol);
        }
      }
    }
  }

  // 4. Compute Coordinates for Top-Level Nodes and Nested SubProcesses
  const layoutNodes = new Map<string, NodeLayout>();

  const minTrack = Math.min(0, ...Array.from(nodeTrack.values()));
  const spineTrack = minTrack === -1 ? -1 : 0;

  // The default track pitch (opts.trackGap) assumes ~80px-tall elements. A track
  // holding something taller (e.g. an expanded SubProcess) needs extra clearance so
  // it doesn't bleed into a neighboring track's band -- compute that once per track
  // from actual element sizes instead of assuming a fixed height everywhere.
  function maxHeightOnTrack(trackVal: number): number {
    let max = 80;
    for (const n of topNodes) {
      if (nodeTrack.get(n.id) === trackVal) max = Math.max(max, getElementDimensions(n).height);
    }
    return max;
  }
  const distinctTracks = Array.from(new Set(nodeTrack.values())).sort((a, b) => a - b);
  const extraClearanceForTrack = new Map<number, number>([[spineTrack, 0]]);
  let cumExtra = 0;
  let prevTrack = spineTrack;
  for (const trackVal of distinctTracks.filter((tv) => tv > spineTrack)) {
    cumExtra += Math.max(0, maxHeightOnTrack(prevTrack) - 80) / 2 + Math.max(0, maxHeightOnTrack(trackVal) - 80) / 2;
    extraClearanceForTrack.set(trackVal, cumExtra);
    prevTrack = trackVal;
  }

  for (const node of topNodes) {
    const c = nodeCol.get(node.id)!;
    const t = nodeTrack.get(node.id)!;
    const dim = getElementDimensions(node);

    const centerX = 75 + c * opts.colWidth;
    let centerY = opts.spineY;

    if (minTrack === -1) {
      if (t === -1) centerY = opts.spineY;
      else if (t === 0) centerY = opts.spineY + opts.trackGap;
      else if (t === 1) centerY = opts.spineY + 2 * opts.trackGap;
      else if (t > 1) centerY = opts.spineY + (t + 1) * opts.trackGap;
    } else {
      if (t === 1) centerY = opts.track1Y;
      else if (t === 2) centerY = opts.track2Y;
      else if (t > 2) centerY = opts.track2Y + (t - 2) * opts.trackGap;
    }
    centerY += extraClearanceForTrack.get(t) ?? 0;

    let x = centerX - dim.width / 2;
    let y = centerY - dim.height / 2;

    if (node.$type === "bpmn:SubProcess") {
      // Expanded subprocess positioning and child elements. x/y/centerY above are
      // already derived from this node's track using its own (360x200) dimensions --
      // keep them, just lay out children relative to that box.
      const childElements: any[] = node.flowElements || [];
      const childNodes = childElements.filter((el) => el.$type !== "bpmn:SequenceFlow");

      // Lay out child nodes internally with clean, compact padding
      // "expandes subprocess has huge horizontal padding"
      let childX = x + 35;
      for (const child of childNodes) {
        const cdim = getElementDimensions(child);
        const childY = centerY - cdim.height / 2;
        layoutNodes.set(child.id, {
          id: child.id,
          element: child,
          col: 0,
          track: t,
          x: childX,
          y: childY,
          width: cdim.width,
          height: cdim.height,
          centerX: childX + cdim.width / 2,
          centerY,
          isSubProcessChild: true,
        });
        childX += cdim.width + 60;
      }
    }

    layoutNodes.set(node.id, {
      id: node.id,
      element: node,
      col: c,
      track: t,
      x,
      y,
      width: dim.width,
      height: dim.height,
      centerX,
      centerY,
    });
  }

  // Collect all flows including child subprocess flows
  const allFlows: any[] = [...topFlows];
  for (const node of topNodes) {
    if (node.$type === "bpmn:SubProcess") {
      allFlows.push(...(node.flowElements || []).filter((el: any) => el.$type === "bpmn:SequenceFlow"));
    }
  }

  return { nodes: layoutNodes, allFlows };
}

interface LabelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function estimateTextLines(text: string, width: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let lines = 1;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;

  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (currentLineWidth === 0) {
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines += 1;
      currentLineWidth = wordWidth;
    }
  }
  return lines;
}

function formatTextForLines(text: string, width: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return text;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;
  const lines: string[][] = [[]];

  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (lines[lines.length - 1]!.length === 0) {
      lines[lines.length - 1]!.push(word);
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      lines[lines.length - 1]!.push(word);
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines.push([word]);
      currentLineWidth = wordWidth;
    }
  }
  return lines.map((l) => l.join(" ")).join("\n");
}

function getCandidateWidthsForNode(name: string, isGateway: boolean): number[] {
  const clean = name.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  if (!isGateway) {
    const initialLines = estimateTextLines(clean, 90);
    return initialLines >= 2 ? [90, 105, 120, 80] : [90];
  }

  // Short single word / short label (<= 9 chars): natural single line
  if (words.length <= 1 || clean.length <= 9) {
    const tightW = Math.max(30, Math.round(clean.length * 6.8) + 8);
    return [tightW, 60, 80];
  }

  // Multi-word gateway label:
  // "Also long single line labels could be narrowed to flow in two lines."
  // "If label is rendered on three lines, it should be made wider to make it fit on two lines."
  const twoLineWidths: number[] = [];
  for (let w = 40; w <= 140; w += 2) {
    const lines = estimateTextLines(clean, w);
    if (lines === 2) {
      twoLineWidths.push(w);
    }
  }

  if (twoLineWidths.length > 0) {
    const min2LineW = twoLineWidths[0]!;
    const median2LineW = twoLineWidths[Math.floor(twoLineWidths.length / 2)]!;
    const max2LineW = twoLineWidths[twoLineWidths.length - 1]!;
    return Array.from(new Set([min2LineW, median2LineW, max2LineW, 70, 80]));
  }

  // If 3+ lines even at 140, widen until it fits 2 lines
  for (let w = 150; w <= 240; w += 10) {
    if (estimateTextLines(clean, w) <= 2) {
      return [w, w + 10];
    }
  }

  return [90, 105, 120];
}

function segmentIntersectsBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  margin = 4,
): boolean {
  const minX = bx - margin;
  const maxX = bx + bw + margin;
  const minY = by - margin;
  const maxY = by + bh + margin;

  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;
  if (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY) return true;

  const dx = x2 - x1;
  const dy = y2 - y1;

  let tEnter = 0;
  let tExit = 1;

  if (dx === 0) {
    if (x1 < minX || x1 > maxX) return false;
  } else {
    const t1 = (minX - x1) / dx;
    const t2 = (maxX - x1) / dx;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }

  if (dy === 0) {
    if (y1 < minY || y1 > maxY) return false;
  } else {
    const t1 = (minY - y1) / dy;
    const t2 = (maxY - y1) / dy;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }

  return tEnter <= tExit;
}

function labelCollidesWithLanes(
  bounds: LabelBounds,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  margin = 4,
): boolean {
  for (const pts of edgeWaypoints.values()) {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (p1 && p2 && segmentIntersectsBox(p1.x, p1.y, p2.x, p2.y, bounds.x, bounds.y, bounds.width, bounds.height, margin)) {
        return true;
      }
    }
  }
  return false;
}

function labelCollidesWithElements(
  bounds: LabelBounds,
  targetId: string,
  nodes: Map<string, NodeLayout>,
): boolean {
  for (const node of nodes.values()) {
    if (node.id === targetId || node.isSubProcessChild) continue;
    if (node.element.$type === "bpmn:SubProcess") continue;
    if (
      bounds.x < node.x + node.width &&
      node.x < bounds.x + bounds.width &&
      bounds.y < node.y + node.height &&
      node.y < bounds.y + bounds.height
    ) {
      return true;
    }
  }
  return false;
}

function labelCollidesWithOtherLabels(
  bounds: LabelBounds,
  placedLabels: LabelBounds[],
): boolean {
  for (const other of placedLabels) {
    if (
      bounds.x < other.x + other.width &&
      other.x < bounds.x + bounds.width &&
      bounds.y < other.y + other.height &&
      other.y < bounds.y + bounds.height
    ) {
      return true;
    }
  }
  return false;
}

function solveLabelPlacement(
  node: NodeLayout,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  nodes: Map<string, NodeLayout>,
  placedLabels: LabelBounds[],
): LabelBounds {
  const name = node.element.name || "";
  const isGateway = node.element.$type.endsWith("Gateway");

  // Determine flow attachments for gateways
  let hasTopFlow = false;
  let hasBottomFlow = false;
  let hasLeftFlow = false;
  let hasRightFlow = false;
  for (const [flowId, pts] of edgeWaypoints.entries()) {
    if (!pts || pts.length === 0) continue;
    const flow = (node.element.incoming || []).concat(node.element.outgoing || []).find((f: any) => f.id === flowId);
    if (!flow) continue;

    const startPt = pts[0];
    const endPt = pts[pts.length - 1];
    if (flow.sourceRef?.id === node.id && startPt) {
      if (startPt.y < node.centerY - 5) hasTopFlow = true;
      else if (startPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (startPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (startPt.x > node.centerX + 5) hasRightFlow = true;
    }
    if (flow.targetRef?.id === node.id && endPt) {
      if (endPt.y < node.centerY - 5) hasTopFlow = true;
      else if (endPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (endPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (endPt.x > node.centerX + 5) hasRightFlow = true;
    }
  }

  // Determine preferred primary orientation (top vs bottom)
  let preferredTop = false;
  if (isGateway) {
    if (hasBottomFlow && !hasTopFlow) preferredTop = true;
  }

  // Check if text is multiple lines at standard width 90
  const initialLines = estimateTextLines(name, 90);

  const isFourDirectionGateway = isGateway && hasTopFlow && hasBottomFlow && hasLeftFlow && hasRightFlow;
  const isLeftFreeGateway = isGateway && hasTopFlow && hasBottomFlow && !hasLeftFlow;
  const isRightFreeGateway = isGateway && hasTopFlow && hasBottomFlow && !hasRightFlow;

  // Candidate widths:
  // "Also long single line labels could be narrowed to flow in two lines."
  // "If label is rendered on three lines, it should be made wider to make it fit on two lines."
  const candidateWidths = getCandidateWidthsForNode(name, isGateway);

  const candidates: Array<LabelBounds & { lines: number }> = [];

  for (const W of candidateWidths) {
    const formatted = formatTextForLines(name, W);
    const lineArray = formatted.split("\n");
    const lines = lineArray.length;
    let maxLineChars = 0;
    for (const l of lineArray) {
      if (l.length > maxLineChars) maxLineChars = l.length;
    }
    const tightW = isGateway ? Math.max(30, Math.min(W, Math.round(maxLineChars * 6.8) + 8)) : W;
    const H = lines === 1 ? (isGateway ? 14 : 20) : (lines === 2 ? 27 : lines * 14);
    const gap = isGateway && lines === 1 ? 2 : 8;

    const primaryY = preferredTop ? Math.round(node.y - H - gap) : Math.round(node.y + node.height + gap);
    const altY = preferredTop ? Math.round(node.y + node.height + gap) : Math.round(node.y - H - gap);

    if (isFourDirectionGateway) {
      // 1. Snug top-left diagonal preferred in 4-direction gateway
      // "Diagonally or horizontally placed gateway labels still feel like being too far from the gateway."
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      // Other snug diagonals as fallbacks
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });
    } else if (isLeftFreeGateway) {
      // "Horizontally placed label should be vertically aligned with gateway center."
      // "Diagonally or horizontally placed gateway labels still feel like being too far from the gateway."
      candidates.push({ x: Math.round(node.x - tightW - 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      // Snug top-left diagonal as fallback
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
    } else if (isRightFreeGateway) {
      candidates.push({ x: Math.round(node.x + node.width + 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
    } else {
      // 1. Primary side centered
      candidates.push({ x: Math.round(node.centerX - tightW / 2), y: primaryY, width: tightW, height: H, lines });

      // 2. Primary side shifted left / right
      for (const dx of [20, -20, 40, -40, 60, -60]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: primaryY, width: tightW, height: H, lines });
      }

      // 3. Alternate side centered + shifted left / right
      candidates.push({ x: Math.round(node.centerX - tightW / 2), y: altY, width: tightW, height: H, lines });
      for (const dx of [20, -20, 40, -40]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: altY, width: tightW, height: H, lines });
      }

      // 4. Snug diagonal positions
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y - H + 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.centerX + 2), y: Math.round(node.y + node.height - 2), width: tightW, height: H, lines });

      // 5. Snug horizontal positions
      candidates.push({ x: Math.round(node.x - tightW - 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
      candidates.push({ x: Math.round(node.x + node.width + 2), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines });
    }
  }

  // Find the first candidate that collides with neither lanes, elements, nor other labels
  let chosen: (LabelBounds & { lines: number }) | null = null;
  for (const cand of candidates) {
    if (cand.x < 10 || cand.y < 0) continue;
    if (labelCollidesWithLanes(cand, edgeWaypoints)) continue;
    if (labelCollidesWithElements(cand, node.id, nodes)) continue;
    if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
    chosen = cand;
    break;
  }

  // Fallback: candidate that does not collide with elements or labels even if it touches a lane
  if (!chosen) {
    for (const cand of candidates) {
      if (cand.x < 10 || cand.y < 0) continue;
      if (labelCollidesWithElements(cand, node.id, nodes)) continue;
      if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
      chosen = cand;
      break;
    }
  }

  if (!chosen) {
    const defaultW = 90;
    const defaultLines = estimateTextLines(name, defaultW);
    const defaultH = defaultLines === 1 ? (isGateway ? 14 : 20) : (defaultLines === 2 ? 27 : defaultLines * 14);
    const defaultGap = isGateway && defaultLines === 1 ? 2 : 8;
    const defaultY = preferredTop
      ? Math.round(node.y - defaultH - defaultGap)
      : Math.round(node.y + node.height + defaultGap);
    chosen = {
      x: Math.round(node.centerX - defaultW / 2),
      y: defaultY,
      width: defaultW,
      height: defaultH,
      lines: defaultLines,
    };
  }

  return {
    x: chosen.x,
    y: chosen.y,
    width: chosen.width,
    height: chosen.height,
  };
}

function shouldUseUpsideRoute(
  src: NodeLayout,
  tgt: NodeLayout,
  layout: ProcessLayoutResult,
  flowId?: string,
): boolean {
  if (!src.element.$type.endsWith("Gateway") || !tgt.element.$type.endsWith("Gateway")) {
    return false;
  }

  // Both gateways must be on the same track (typically Track 0)
  if (src.track !== tgt.track) {
    return false;
  }

  // Check if there are nodes on upper tracks that would block the upside route
  const minTrack = Math.min(0, ...Array.from(layout.nodes.values()).map((n) => n.track));
  const minCol = Math.min(src.col, tgt.col);
  const maxCol = Math.max(src.col, tgt.col);
  if (minTrack < 0) {
    const hasUpperObstacle = Array.from(layout.nodes.values()).some(
      (n) => n.track < 0 && n.col >= minCol && n.col <= maxCol,
    );
    if (hasUpperObstacle) return false;
  }

  // Intermediate nodes along the track (must skip intermediate nodes)
  const intermediateNodes = Array.from(layout.nodes.values()).filter(
    (n) => n.id !== src.id && n.id !== tgt.id && n.track === src.track && n.col > minCol && n.col < maxCol,
  );
  if (intermediateNodes.length === 0) {
    return false;
  }

  // Check other incoming flows to tgt on the same track
  const otherIncomingSameTrack = layout.allFlows.filter((f) => {
    if (f.id === flowId || f.targetRef?.id !== tgt.id) return false;
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    return fSrc && fSrc.track === tgt.track && fSrc.id !== src.id;
  });

  // If multiple bypass flows on the same track target tgt, only the longest span takes the upside route
  const currentSpan = Math.abs(src.col - tgt.col);
  const isLongerThanOtherBypasses = otherIncomingSameTrack.every((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id)!;
    const otherSpan = Math.abs(fSrc.col - tgt.col);
    return currentSpan > otherSpan;
  });

  if (!isLongerThanOtherBypasses) {
    return false;
  }

  // If this flow is a loop-back (tgt.col <= src.col) but src also has a forward bypass,
  // let the forward bypass take the upside route while this loop-back takes the bottom route
  if (tgt.col <= src.col) {
    const hasForwardBypass = layout.allFlows.some((f) => {
      if (f.id === flowId || f.sourceRef?.id !== src.id) return false;
      const fTgt = layout.nodes.get(f.targetRef?.id);
      return fTgt && fTgt.track === src.track && fTgt.col > src.col + 1;
    });
    if (hasForwardBypass) return false;
  }

  // Check if src already has another outgoing flow that uses the bottom vertex
  const otherOutgoing = layout.allFlows.filter((f) => f.id !== flowId && f.sourceRef?.id === src.id);
  const srcHasBottomOutgoing = otherOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= src.col || fTgt.track > src.track;
  });

  // Check if tgt already has another incoming flow that uses the bottom vertex
  const otherIncoming = layout.allFlows.filter((f) => f.id !== flowId && f.targetRef?.id === tgt.id);
  const tgtHasBottomIncoming = otherIncoming.some((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    if (!fSrc) return false;
    return tgt.col <= fSrc.col || fSrc.track > tgt.track;
  });

  // Check if tgt has an outgoing flow that uses the bottom vertex (e.g. branch to lower track)
  const tgtOutgoing = layout.allFlows.filter((f) => f.sourceRef?.id === tgt.id);
  const tgtHasBottomOutgoing = tgtOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= tgt.col || fTgt.track > tgt.track;
  });

  if (srcHasBottomOutgoing || tgtHasBottomIncoming || tgtHasBottomOutgoing || otherIncoming.length > 0) {
    return true;
  }

  return false;
}

function computeEdgeLabelBounds(
  flow: any,
  waypoints: Array<{ x: number; y: number }>,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  placedLabels: LabelBounds[] = [],
): LabelBounds | null {
  if (!flow.name || typeof flow.name !== "string" || flow.name.trim().length === 0) {
    return null;
  }
  const text = flow.name.trim();

  // Find candidate segments
  let bestSeg: { p1: { x: number; y: number }; p2: { x: number; y: number }; isHoriz: boolean; len: number } | null = null;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    if (!p1 || !p2) continue;
    const isHoriz = p1.y === p2.y;
    const isVert = p1.x === p2.x;
    const len = isHoriz ? Math.abs(p2.x - p1.x) : (isVert ? Math.abs(p2.y - p1.y) : 0);

    // Prefer horizontal segment with length >= 30
    if (isHoriz && len >= 30) {
      if (!bestSeg || !bestSeg.isHoriz || len > bestSeg.len) {
        bestSeg = { p1, p2, isHoriz: true, len };
      }
    } else if (!bestSeg && len >= 20) {
      bestSeg = { p1, p2, isHoriz: false, len };
    }
  }

  if (!bestSeg) return null;

  const width = Math.min(90, Math.max(30, Math.round(text.length * 6.5) + 10));
  const height = 14;

  if (bestSeg.isHoriz) {
    const minX = Math.min(bestSeg.p1.x, bestSeg.p2.x);
    const maxX = Math.max(bestSeg.p1.x, bestSeg.p2.x);
    const midX = (minX + maxX) / 2;

    // Check if there is another flow running above this segment or if segment is at or above Y=0
    // "ok" lane is pretty close to "another turn" lane, maybe label could have been on the bottom side of lane
    const hasFlowAbove = bestSeg.p1.y <= 0 || Array.from(edgeWaypoints.values()).some((pts) => {
      for (let j = 0; j < pts.length - 1; j++) {
        const q1 = pts[j];
        const q2 = pts[j + 1];
        if (!q1 || !q2) continue;
        if (q1.y === q2.y && q1.y < bestSeg!.p1.y && bestSeg!.p1.y - q1.y <= 40) {
          const qMinX = Math.min(q1.x, q2.x);
          const qMaxX = Math.max(q1.x, q2.x);
          if (Math.max(minX, qMinX) < Math.min(maxX, qMaxX)) return true;
        }
      }
      return false;
    });

    const primaryY = hasFlowAbove ? Math.round(bestSeg.p1.y + 4) : Math.round(bestSeg.p1.y - height - 2);
    const altY = hasFlowAbove ? Math.round(bestSeg.p1.y - height - 2) : Math.round(bestSeg.p1.y + 4);
    const centeredX = Math.round(midX - width / 2);

    const candidates: LabelBounds[] = [];
    for (const y of [primaryY, altY]) {
      for (const dx of [0, 20, -20, 40, -40]) {
        candidates.push({ x: centeredX + dx, y, width, height });
      }
    }
    const chosen = candidates.find((cand) => cand.y >= 0 && !labelCollidesWithOtherLabels(cand, placedLabels));
    return chosen ?? { x: centeredX, y: primaryY, width, height };
  } else {
    // Vertical segment: sit 4px to the right of the vertical line, or to the left
    // if that collides with an already-placed label.
    const minY = Math.min(bestSeg.p1.y, bestSeg.p2.y);
    const maxY = Math.max(bestSeg.p1.y, bestSeg.p2.y);
    const midY = (minY + maxY) / 2;
    const y = Math.round(midY - height / 2);
    const rightX = Math.round(bestSeg.p1.x + 4);
    const leftX = Math.round(bestSeg.p1.x - width - 4);

    const candidates: LabelBounds[] = [
      { x: rightX, y, width, height },
      { x: leftX, y, width, height },
    ];
    const chosen = candidates.find((cand) => cand.x >= 0 && !labelCollidesWithOtherLabels(cand, placedLabels));
    return chosen ?? { x: rightX, y, width, height };
  }
}

function createProcessDi(
  moddle: any,
  rootElement: any,
  process: any,
  layout: ProcessLayoutResult,
  opts: Required<AutoLayoutOptions>,
) {
  const planeElements: any[] = [];

  // 1. Precompute Edge DI waypoints for each sequence flow
  const edgeWaypoints = new Map<string, Array<{ x: number; y: number }>>();
  for (const flow of layout.allFlows) {
    const src = layout.nodes.get(flow.sourceRef?.id);
    const tgt = layout.nodes.get(flow.targetRef?.id);
    if (!src || !tgt) continue;
    edgeWaypoints.set(flow.id, computeWaypoints(src, tgt, layout, opts, flow));
  }

  const placedLabels: LabelBounds[] = [];

  // 1.5 Precompute edge labels first and reserve their space, so node label
  // placement (which already avoids other placed labels) also avoids edge labels
  // instead of only ever avoiding other node labels.
  const edgeLabelBounds = new Map<string, LabelBounds>();
  for (const flow of layout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;
    const edgeLabel = computeEdgeLabelBounds(flow, waypoints, edgeWaypoints, placedLabels);
    if (edgeLabel) {
      edgeLabelBounds.set(flow.id, edgeLabel);
      placedLabels.push(edgeLabel);
    }
  }

  // 2. Create Shape DI for each node with collision-free labels
  for (const [id, node] of layout.nodes.entries()) {
    const isMarkerVisible = node.element.$type.endsWith("Gateway") ? true : undefined;
    const isExpanded = node.element.$type === "bpmn:SubProcess" ? true : undefined;

    const shapeAttrs: any = {
      id: `${id}_di`,
      bpmnElement: node.element,
      bounds: moddle.create("dc:Bounds", {
        x: Math.round(node.x),
        y: Math.round(node.y),
        width: Math.round(node.width),
        height: Math.round(node.height),
      }),
    };
    if (isMarkerVisible !== undefined) shapeAttrs.isMarkerVisible = isMarkerVisible;
    if (isExpanded !== undefined) shapeAttrs.isExpanded = isExpanded;

    // External label for Events and Gateways with visible name
    const hasName = typeof node.element.name === "string" && node.element.name.trim().length > 0;
    const needsLabel = (node.element.$type.endsWith("Event") || node.element.$type.endsWith("Gateway")) && hasName;

    if (needsLabel) {
      const labelBounds = solveLabelPlacement(node, edgeWaypoints, layout.nodes, placedLabels);
      placedLabels.push(labelBounds);

      shapeAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: labelBounds.x,
          y: labelBounds.y,
          width: labelBounds.width,
          height: labelBounds.height,
        }),
      });
    }

    planeElements.push(moddle.create("bpmndi:BPMNShape", shapeAttrs));
  }

  // 3. Create Edge DI for each sequence flow
  for (const flow of layout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;

    const edgeDiAttrs: any = {
      id: `${flow.id}_di`,
      bpmnElement: flow,
      waypoint: waypoints.map((pt) =>
        moddle.create("dc:Point", {
          x: Math.round(pt.x),
          y: Math.round(pt.y),
        }),
      ),
    };

    const edgeLabel = edgeLabelBounds.get(flow.id);
    if (edgeLabel) {
      edgeDiAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: edgeLabel.x,
          y: edgeLabel.y,
          width: edgeLabel.width,
          height: edgeLabel.height,
        }),
      });
    }

    const edgeDi = moddle.create("bpmndi:BPMNEdge", edgeDiAttrs);
    planeElements.push(edgeDi);
  }

  const plane = moddle.create("bpmndi:BPMNPlane", {
    id: `BPMNPlane_${process.id}`,
    bpmnElement: process,
    planeElement: planeElements,
  });

  const diagram = moddle.create("bpmndi:BPMNDiagram", {
    id: `BPMNDiagram_${process.id}`,
    plane,
  });

  rootElement.diagrams.push(diagram);
}

function computeWaypoints(
  src: NodeLayout,
  tgt: NodeLayout,
  layout: ProcessLayoutResult,
  opts: Required<AutoLayoutOptions>,
  flow?: any,
): Array<{ x: number; y: number }> {
  // Case 1: SubProcess child internal flow
  if (src.isSubProcessChild && tgt.isSubProcessChild) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
  }

  const minTrack = Math.min(0, ...Array.from(layout.nodes.values()).map((n) => n.track));

  // Case 1.5: Upside route between exclusive gateways to prevent lane collisions
  if (shouldUseUpsideRoute(src, tgt, layout, flow?.id)) {
    const isLoopBack = tgt.col <= src.col;
    let upperChannelY = minTrack < 0 ? opts.spineY - opts.trackGap : Math.max(0, opts.spineY - 70);
    if (isLoopBack && upperChannelY === 0) {
      // Place long process loop-backs in upper channel 2 (Y = -20) so local forward bypasses (Y = 0) do not overlap
      upperChannelY = -20;
    }
    return [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: upperChannelY },
      { x: tgt.centerX, y: upperChannelY },
      { x: tgt.centerX, y: tgt.y },
    ];
  }

  // Case 2: Loop-back / Back-edge (target column <= source column)
  if (tgt.col <= src.col) {
    let channelY = opts.channel1Y;
    if (minTrack < 0) {
      channelY = 290;
    } else {
      if (src.track === 1) channelY = opts.channel2Y;
      if (src.track === 2) channelY = opts.channel3Y;
    }

    const startY = src.y + src.height;
    const endY = tgt.y + tgt.height;

    return [
      { x: src.centerX, y: startY },
      { x: src.centerX, y: channelY },
      { x: tgt.centerX, y: channelY },
      { x: tgt.centerX, y: endY },
    ];
  }

  // Case 3: Same track, forward flow
  if (src.track === tgt.track) {
    // Check if any node on the same track lies between src and tgt
    const hasObstacle = Array.from(layout.nodes.values()).some(
      (n) =>
        n.id !== src.id &&
        n.id !== tgt.id &&
        n.track === src.track &&
        !n.isSubProcessChild &&
        n.centerX > src.centerX &&
        n.centerX < tgt.centerX,
    );

    const srcExitY = src.element.$type === "bpmn:SubProcess" ? opts.track1Y : src.centerY;
    const tgtEntryY = tgt.element.$type === "bpmn:SubProcess" ? opts.track1Y : tgt.centerY;

    if (!hasObstacle) {
      return [
        { x: src.x + src.width, y: srcExitY },
        { x: tgt.x, y: tgtEntryY },
      ];
    }

    // Forward bypass skipping intermediate elements on same track via channel
    let channelY = src.track === 0 ? opts.channel1Y : opts.channel2Y;
    if (minTrack < 0 && src.track === 0) channelY = 290;
    return [
      { x: src.centerX, y: src.y + src.height },
      { x: src.centerX, y: channelY },
      { x: tgt.centerX, y: channelY },
      { x: tgt.centerX, y: tgt.y + tgt.height },
    ];
  }

  // Case 4: Branching UP from gateway to upper track (e.g. Track 0 -> Track -1)
  if (src.track > tgt.track && src.element.$type.endsWith("Gateway") && !tgt.element.$type.endsWith("Gateway")) {
    return [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: tgt.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
  }

  // Case 5: Merging DOWN from upper track into a gateway (e.g. Track -1 -> Track 0)
  if (src.track < tgt.track && tgt.element.$type.endsWith("Gateway") && src.centerY < tgt.centerY) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y },
    ];
  }

  // Case 6: Branching down from gateway to lower track
  if (src.track < tgt.track) {
    // Exits bottom of gateway
    if (src.element.$type.endsWith("Gateway")) {
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: tgt.centerY },
        { x: tgt.x, y: tgt.centerY },
      ];
    }
    // Exits right of task, drops to target centerY
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: tgt.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
  }

  // Case 7: Merging up from lower track into a gateway
  if (src.track > tgt.track && tgt.element.$type.endsWith("Gateway")) {
    const isOtherExit = layout.allFlows.some(
      (f) => f.id !== flow?.id && f.sourceRef?.id === src.id && (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track,
    );
    const otherFlow = layout.allFlows.find(
      (f) => f.id !== flow?.id && f.sourceRef?.id === src.id && (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track,
    );
    const otherTgt = otherFlow ? layout.nodes.get(otherFlow.targetRef?.id) : null;
    const isLonger = otherTgt ? tgt.col > otherTgt.col : false;

    if (isOtherExit && isLonger && src.element.$type.endsWith("Gateway")) {
      const channelY = src.track === 1 ? opts.channel2Y : opts.channel3Y;
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: channelY },
        { x: tgt.centerX, y: channelY },
        { x: tgt.centerX, y: tgt.y + tgt.height },
      ];
    }

    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y + tgt.height },
    ];
  }

  // Fallback orthogonal
  return [
    { x: src.x + src.width, y: src.centerY },
    { x: tgt.centerX, y: src.centerY },
    { x: tgt.centerX, y: tgt.centerY },
    { x: tgt.x, y: tgt.centerY },
  ];
}
