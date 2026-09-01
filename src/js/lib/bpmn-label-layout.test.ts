import { describe, expect, it } from "vitest";
import { labelLayout } from "./bpmn-label-layout";

type Bounds = { x: number; y: number; width: number; height: number };

function definitions(
  elements: Array<Record<string, unknown>>,
  diElements: Array<Record<string, unknown>>,
  lanes: Array<Record<string, unknown>> = [],
) {
  return {
    id: "definitions",
    $type: "bpmn:Definitions",
    rootElements: [
      {
        id: "process",
        $type: "bpmn:Process",
        flowElements: elements,
        laneSets: lanes.length ? [{ lanes }] : [],
      },
    ],
    diagrams: [
      {
        plane: {
          bpmnElement: { id: "process" },
          planeElement: diElements,
        },
      },
    ],
  };
}

function shape(id: string, type: string, bounds: Bounds, label?: Bounds) {
  return {
    id,
    $type: type,
    name: id,
    ...(label ? { label: { bounds: label } } : {}),
    di: { bpmnElement: { id }, bounds },
  };
}

function reports(model: unknown): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  labelLayout().check(model as never, {
    report: (id, message) => result.push([id, message]),
  });
  return result;
}

function withDi(elements: Array<Record<string, unknown>>) {
  return elements.map((element) => {
    const { di: rawDi, ...semantic } = element;
    const { bpmnElement: _bpmnElement, ...di } = rawDi as { bpmnElement: unknown; bounds: Bounds };
    return { ...di, bpmnElement: semantic, ...(semantic.label ? { label: semantic.label } : {}) };
  });
}

describe("labelLayout", () => {
  it("requires named events and gateways to have label bounds", () => {
    const model = definitions(
      [{ id: "start", $type: "bpmn:StartEvent", name: "Start" }],
      [{ bpmnElement: { id: "start" }, bounds: { x: 0, y: 0, width: 36, height: 36 } }],
    );
    expect(reports(model)).toEqual([["start", "Named element is missing its BPMN label DI"]]);
  });

  it("rejects label overlap with an unrelated shape", () => {
    const event = shape("event", "bpmn:StartEvent", { x: 0, y: 0, width: 36, height: 36 }, { x: 0, y: 36, width: 90, height: 20 });
    const task = shape("task", "bpmn:Task", { x: 20, y: 40, width: 100, height: 80 });
    const model = definitions([event, task], withDi([event, task]));
    expect(reports(model)).toContainEqual(["event", "BPMN label overlaps element 'task'"]);
  });

  it("allows an external label to sit outside its own target", () => {
    const event = shape("event", "bpmn:StartEvent", { x: 0, y: 0, width: 36, height: 36 }, { x: -27, y: 36, width: 90, height: 20 });
    const model = definitions([event], withDi([event]));
    expect(reports(model)).toEqual([]);
  });

  it("rejects overlapping external labels", () => {
    const first = shape("first", "bpmn:ExclusiveGateway", { x: 0, y: 0, width: 50, height: 50 }, { x: 0, y: 60, width: 90, height: 20 });
    const second = shape("second", "bpmn:ExclusiveGateway", { x: 150, y: 0, width: 50, height: 50 }, { x: 40, y: 60, width: 90, height: 20 });
    const model = definitions([first, second], withDi([first, second]));
    expect(reports(model)).toEqual([
      ["first", "BPMN label overlaps label for 'second'"],
      ["second", "BPMN label overlaps label for 'first'"],
    ]);
  });

  it("keeps a named lane label inside the lane boundary", () => {
    const lane = { id: "lane", $type: "bpmn:Lane" };
    const event = shape("event", "bpmn:StartEvent", { x: 100, y: 20, width: 36, height: 36 }, { x: 73, y: 56, width: 90, height: 20 });
    const model = definitions([event], [...withDi([event]), { bpmnElement: lane, bounds: { x: 0, y: 0, width: 300, height: 70 } }], [lane]);
    expect(reports(model)).toContainEqual(["event", "BPMN label must remain inside boundary 'lane'"]);
  });

  it("does not inspect callActivity targets or called-process diagrams", () => {
    const call = { id: "call", $type: "bpmn:CallActivity", name: "Delegate", calledElement: "child" };
    const model = definitions([call], [{ bpmnElement: { id: "call" }, bounds: { x: 0, y: 0, width: 100, height: 80 } }]);
    expect(reports(model)).toEqual([]);
  });
});
