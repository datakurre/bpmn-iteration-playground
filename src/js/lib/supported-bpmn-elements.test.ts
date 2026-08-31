import { describe, it, expect } from "vitest";
import { onlySupportedElements, SUPPORTED_ELEMENT_TYPES, SUPPORTED_EVENT_DEFINITIONS } from "./supported-bpmn-elements";

// bpmnlint always hands rules real moddle elements, which implement
// `$instanceOf` across the whole BPMN type hierarchy (a `bpmn:ServiceTask` is
// also a `bpmn:FlowElement`, say) -- mirror that here rather than relying on
// an exact `$type` match, which no real element would ever satisfy against
// the wrapper types this rule filters on.
const FLOW_ELEMENT_TYPES = new Set([
  "bpmn:StartEvent",
  "bpmn:EndEvent",
  "bpmn:ServiceTask",
  "bpmn:UserTask",
  "bpmn:ExclusiveGateway",
  "bpmn:InclusiveGateway",
  "bpmn:ParallelGateway",
  "bpmn:CallActivity",
  "bpmn:SubProcess",
  "bpmn:SequenceFlow",
  "bpmn:BoundaryEvent",
]);

function node(id: string, $type: string, eventDefinitions?: { $type: string }[]) {
  return {
    id,
    $type,
    $instanceOf: (type: string) => type === $type || (type === "bpmn:FlowElement" && FLOW_ELEMENT_TYPES.has($type)),
    ...(eventDefinitions ? { eventDefinitions } : {}),
  };
}

describe("onlySupportedElements", () => {
  it("does not report an allowed flow element", () => {
    const reports: unknown[] = [];
    const rule = onlySupportedElements();
    rule.check(node("task1", "bpmn:ServiceTask"), { report: (...args) => reports.push(args) });
    expect(reports).toEqual([]);
  });

  it("reports a disallowed flow element, naming the allowed types", () => {
    const reports: [string, string][] = [];
    const rule = onlySupportedElements();
    rule.check(node("gw1", "bpmn:InclusiveGateway"), { report: (id, message) => reports.push([id, message]) });
    expect(reports).toHaveLength(1);
    expect(reports[0]![0]).toBe("gw1");
    expect(reports[0]![1]).toContain("bpmn:InclusiveGateway");
    expect(reports[0]![1]).toContain("bpmn:ServiceTask");
  });

  it("ignores nodes that are neither a flow element nor an artifact", () => {
    const reports: unknown[] = [];
    const rule = onlySupportedElements();
    rule.check(node("Defs_1", "bpmn:Definitions"), { report: (...args) => reports.push(args) });
    rule.check(node("Process_1", "bpmn:Process"), { report: (...args) => reports.push(args) });
    expect(reports).toEqual([]);
  });

  it("respects a real $instanceOf implementation, not just exact $type", () => {
    const reports: unknown[] = [];
    const rule = onlySupportedElements();
    const el = {
      id: "gw2",
      $type: "bpmn:ComplexGateway",
      $instanceOf: (type: string) => type === "bpmn:FlowElement" || type === "bpmn:ComplexGateway",
    };
    rule.check(el, { report: (...args) => reports.push(args) });
    expect(reports).toHaveLength(1);
  });

  it("SUPPORTED_ELEMENT_TYPES covers every element type used across workflows/*.bpmn, plus fork/join and boundary events", () => {
    expect([...SUPPORTED_ELEMENT_TYPES].sort()).toEqual(
      [
        "bpmn:CallActivity",
        "bpmn:EndEvent",
        "bpmn:ExclusiveGateway",
        "bpmn:ParallelGateway",
        "bpmn:SequenceFlow",
        "bpmn:ServiceTask",
        "bpmn:StartEvent",
        "bpmn:SubProcess",
        "bpmn:UserTask",
        "bpmn:BoundaryEvent",
      ].sort(),
    );
  });

  it("does not report an event with an allowed event definition", () => {
    const reports: unknown[] = [];
    const rule = onlySupportedElements();
    rule.check(node("end1", "bpmn:EndEvent", [{ $type: "bpmn:TerminateEventDefinition" }]), {
      report: (...args) => reports.push(args),
    });
    expect(reports).toEqual([]);
  });

  it("reports a disallowed event definition, naming the allowed set", () => {
    const reports: [string, string][] = [];
    const rule = onlySupportedElements();
    rule.check(node("boundary1", "bpmn:BoundaryEvent", [{ $type: "bpmn:MessageEventDefinition" }]), {
      report: (id, message) => reports.push([id, message]),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]![0]).toBe("boundary1");
    expect(reports[0]![1]).toContain("bpmn:MessageEventDefinition");
    expect(reports[0]![1]).toContain("bpmn:TimerEventDefinition");
  });

  it("does not check event definitions on a disallowed element type -- the element-type report is enough", () => {
    const reports: unknown[] = [];
    const rule = onlySupportedElements();
    rule.check(node("gw3", "bpmn:InclusiveGateway", [{ $type: "bpmn:MessageEventDefinition" }]), {
      report: (...args) => reports.push(args),
    });
    expect(reports).toHaveLength(1);
  });

  it("SUPPORTED_EVENT_DEFINITIONS is scoped to Terminate/Timer/Error", () => {
    expect([...SUPPORTED_EVENT_DEFINITIONS].sort()).toEqual(
      ["bpmn:ErrorEventDefinition", "bpmn:TerminateEventDefinition", "bpmn:TimerEventDefinition"].sort(),
    );
  });
});
