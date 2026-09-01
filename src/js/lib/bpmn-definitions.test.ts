import { describe, expect, it } from "vitest";
import { definitionPath, inspectBpmnDefinitions } from "./bpmn-definitions.ts";

describe("BPMN definition navigation metadata", () => {
  it("connects called processes to their callActivities", () => {
    const definitions = inspectBpmnDefinitions({
      rootElements: [
        { $type: "bpmn:Process", id: "root", name: "Root", isExecutable: true, flowElements: [{ $type: "bpmn:CallActivity", id: "call", calledElement: "child" }] },
        { $type: "bpmn:Process", id: "child", name: "Child", flowElements: [] },
      ],
      diagrams: [
        { id: "d-root", plane: { bpmnElement: { id: "root" } } },
        { id: "d-child", plane: { bpmnElement: { id: "child" } } },
      ],
    });
    expect(definitions).toEqual([
      { processId: "root", name: "Root", isRoot: true, diagramId: "d-root", calledProcessIds: ["child"] },
      { processId: "child", name: "Child", isRoot: false, diagramId: "d-child", parentProcessId: "root", viaCallActivityId: "call", calledProcessIds: [] },
    ]);
    expect(definitionPath(definitions, "child").map((item) => item.processId)).toEqual(["root", "child"]);
  });
});
