/** Definition metadata shared by the live viewer and headless report renderer. */

export interface BpmnDefinitionInfo {
  processId: string;
  name: string;
  isRoot: boolean;
  diagramId?: string;
  parentProcessId?: string;
  viaCallActivityId?: string;
  calledProcessIds: string[];
}

interface BpmnElementLike {
  id?: string;
  $type?: string;
  name?: string;
  calledElement?: string;
  isExecutable?: boolean;
  flowElements?: BpmnElementLike[];
}

interface BpmnDiagramLike {
  id?: string;
  plane?: { bpmnElement?: BpmnElementLike };
}

interface BpmnDefinitionsLike {
  rootElements?: BpmnElementLike[];
  diagrams?: BpmnDiagramLike[];
}

/** Build a navigable process tree from the definitions object bpmn-js exposes. */
export function inspectBpmnDefinitions(definitions: BpmnDefinitionsLike | undefined): BpmnDefinitionInfo[] {
  const processes = (definitions?.rootElements || []).filter((element) => element.$type === "bpmn:Process" && element.id);
  const diagrams = definitions?.diagrams || [];
  const byId = new Map(processes.map((process) => [process.id!, process]));
  const callers = new Map<string, { processId: string; activityId: string }>();

  for (const process of processes) {
    for (const element of process.flowElements || []) {
      if (element.$type === "bpmn:CallActivity" && element.calledElement && byId.has(element.calledElement)) {
        callers.set(element.calledElement, { processId: process.id!, activityId: element.id || "" });
      }
    }
  }

  return processes.map((process, index) => {
    const diagram = diagrams.find((candidate) => candidate.plane?.bpmnElement?.id === process.id);
    const caller = callers.get(process.id!);
    const calledProcessIds = (process.flowElements || [])
      .filter((element) => element.$type === "bpmn:CallActivity" && element.calledElement && byId.has(element.calledElement))
      .map((element) => element.calledElement!);
    return {
      processId: process.id!,
      name: process.name || process.id!,
      isRoot: !caller && (process.isExecutable === true || index === 0),
      ...(diagram?.id ? { diagramId: diagram.id } : {}),
      ...(caller ? { parentProcessId: caller.processId, viaCallActivityId: caller.activityId } : {}),
      calledProcessIds,
    };
  });
}

export function definitionPath(definitions: BpmnDefinitionInfo[], processId: string): BpmnDefinitionInfo[] {
  const byId = new Map(definitions.map((definition) => [definition.processId, definition]));
  const path: BpmnDefinitionInfo[] = [];
  let current = byId.get(processId);
  while (current) {
    path.unshift(current);
    current = current.parentProcessId ? byId.get(current.parentProcessId) : undefined;
  }
  return path;
}
