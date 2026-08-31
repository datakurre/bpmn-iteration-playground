// The BPMN element types this project's runtime (bpmn-elements via bpmn-engine)
// and harnesses actually exercise -- confirmed by grepping every element tag
// across workflows/*.bpmn. The default bpmn-js palette and bpmnlint's
// "recommended" config both allow far more than this (inclusive/complex/
// parallel gateways, intermediate/boundary events, pools, lanes, data
// objects...), none of which has any tested engine behaviour here. This is
// the one shared allowlist both the editor (src/js/lib/supported-elements-rules.ts)
// and every bpmnlint config in the repo (src/js/lib/bpmnlint-static-config.ts,
// src/agent/bpmn-lint.ts, scripts/bpmn-tools.mjs) enforce, so a human or a
// drafting model can't produce a diagram this project has no behaviour for.
export const SUPPORTED_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "bpmn:StartEvent",
  "bpmn:EndEvent",
  "bpmn:SequenceFlow",
  "bpmn:ServiceTask",
  "bpmn:UserTask",
  "bpmn:ExclusiveGateway",
  "bpmn:CallActivity",
  "bpmn:SubProcess",
]);

interface BpmnlintNode {
  id: string;
  $type: string;
  $instanceOf?(type: string): boolean;
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
 * `SUPPORTED_ELEMENT_TYPES`. Modeled directly on bpmnlint's own
 * `checkDiscouragedNodeType` (`bpmnlint/rules/helper.js`) -- the same
 * "walk every node, report the ones that match" shape every rule in
 * `bpmnlint-static-config.ts` already follows.
 */
export function onlySupportedElements() {
  return {
    check(node: BpmnlintNode, reporter: BpmnlintReporter) {
      if (!isAny(node, ["bpmn:FlowElement", "bpmn:Artifact"])) return;
      if (SUPPORTED_ELEMENT_TYPES.has(node.$type)) return;
      reporter.report(
        node.id,
        `Element type <${node.$type}> is not supported by this project's runtime -- allowed types are: ${[...SUPPORTED_ELEMENT_TYPES].sort().join(", ")}`,
      );
    },
  };
}
