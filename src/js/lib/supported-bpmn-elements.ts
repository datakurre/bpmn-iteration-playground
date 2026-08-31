// The BPMN element types this project's runtime (bpmn-elements via bpmn-engine)
// actually supports well. Originally derived from "what's used in
// workflows/*.bpmn today"; bpmn:ParallelGateway and bpmn:BoundaryEvent were
// added after confirming directly against bpmn-elements' own source that
// fork/join (Activity.js's isParallelJoin) and attach-to-host/cancelActivity
// (events/BoundaryEvent.js) are real, mature implementations, not stubs --
// unlike e.g. inclusive/complex gateways, which bpmnlint's own recommended
// config already discourages. The default bpmn-js palette and bpmnlint's
// "recommended" config both allow far more than this (pools, lanes, data
// objects, most event types...), none of which has any tested engine
// behaviour here. This is the one shared allowlist both the editor
// (src/js/lib/supported-elements-rules.ts) and every bpmnlint config in the
// repo (src/js/lib/bpmnlint-static-config.ts, src/agent/bpmn-lint.ts,
// scripts/bpmn-tools.mjs) enforce, so a human or a drafting model can't
// produce a diagram this project has no behaviour for.
export const SUPPORTED_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "bpmn:StartEvent",
  "bpmn:EndEvent",
  "bpmn:SequenceFlow",
  "bpmn:ServiceTask",
  "bpmn:UserTask",
  "bpmn:ExclusiveGateway",
  "bpmn:ParallelGateway",
  "bpmn:CallActivity",
  "bpmn:SubProcess",
  "bpmn:BoundaryEvent",
]);

// A boundary event (or any other event) is only meaningful with a real event
// definition -- a "none" boundary event isn't a real BPMN thing. Scoped to
// the two clearly-justified agent-orchestration patterns: a timeout on a
// long-running activity, and catching a business error. Message/Signal/
// Escalation/Compensate are deferred to a later pass via the same mechanism,
// if ever needed. bpmn:TerminateEventDefinition is already used by
// pi-default-loop.bpmn's own end event.
export const SUPPORTED_EVENT_DEFINITIONS: ReadonlySet<string> = new Set([
  "bpmn:TerminateEventDefinition",
  "bpmn:TimerEventDefinition",
  "bpmn:ErrorEventDefinition",
  "bpmn:ConditionalEventDefinition",
]);

interface BpmnlintEventDefinition {
  $type: string;
}

interface BpmnlintNode {
  id: string;
  $type: string;
  $instanceOf?(type: string): boolean;
  /** Present on bpmn:ThrowEvent/CatchEvent (start/end/boundary events, etc). */
  eventDefinitions?: BpmnlintEventDefinition[];
}

interface BpmnlintReporter {
  report(id: string, message: string): void;
}

function isAny(node: BpmnlintNode, types: string[]): boolean {
  return types.some((type) =>
    typeof node.$instanceOf === "function" ? node.$instanceOf(type) : node.$type === type,
  );
}

/**
 * bpmnlint rule: reject any flow element or artifact whose type isn't in
 * `SUPPORTED_ELEMENT_TYPES`, or (for a start/end/boundary/etc event) whose
 * event definition isn't in `SUPPORTED_EVENT_DEFINITIONS`. Modeled directly
 * on bpmnlint's own `checkDiscouragedNodeType` (`bpmnlint/rules/helper.js`)
 * -- the same "walk every node, report the ones that match" shape every rule
 * in `bpmnlint-static-config.ts` already follows.
 */
export function onlySupportedElements() {
  return {
    check(node: BpmnlintNode, reporter: BpmnlintReporter) {
      if (!isAny(node, ["bpmn:FlowElement", "bpmn:Artifact"])) return;
      if (!SUPPORTED_ELEMENT_TYPES.has(node.$type)) {
        reporter.report(
          node.id,
          `Element type <${node.$type}> is not supported by this project's runtime -- allowed types are: ${[...SUPPORTED_ELEMENT_TYPES].sort().join(", ")}`,
        );
        return;
      }
      for (const def of node.eventDefinitions ?? []) {
        if (SUPPORTED_EVENT_DEFINITIONS.has(def.$type)) continue;
        reporter.report(
          node.id,
          `Event definition <${def.$type}> is not supported by this project's runtime -- allowed event definitions are: ${[...SUPPORTED_EVENT_DEFINITIONS].sort().join(", ")}`,
        );
      }
    },
  };
}
