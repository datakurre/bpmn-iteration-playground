import { describe, it, expect } from "vitest";
import { layoutProcess } from "../js/lib/bpmn-auto-layout.ts";
import { lintBpmn, lintBpmnSemantics } from "./bpmn-lint.ts";

const NAMESPACES =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

function graph(middle: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<bpmn:definitions ${NAMESPACES} id="Defs_1" targetNamespace="http://graph-agent/bpmn">\n` +
    `  <bpmn:process id="proc_1" isExecutable="true">\n` +
    `    ${middle}\n` +
    `  </bpmn:process>\n` +
    `</bpmn:definitions>`
  );
}

describe("lintBpmn", () => {
  it("reports no errors for a small, fully-supported graph", async () => {
    const xml = await layoutProcess(
      graph(`
       <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
       <bpmn:endEvent id="end"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
      <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="end" />
    `),
    );
    const report = await lintBpmn(xml);
    expect(report.errors).toBe(0);
  });

  it("rejects a disallowed element type (issue: only supported elements)", async () => {
    const xml = await layoutProcess(
      graph(`
      <bpmn:startEvent id="start" name="Start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:inclusiveGateway id="gw" name="Gate"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:inclusiveGateway>
      <bpmn:endEvent id="end" name="End"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
      <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
      <bpmn:sequenceFlow id="f2" sourceRef="gw" targetRef="end" />
    `),
    );
    const report = await lintBpmn(xml);
    const message = report.lines.join("\n");
    expect(message).toContain("bpmn:InclusiveGateway");
    expect(message).toContain("not supported by this project's runtime");
    expect(report.errors).toBeGreaterThan(0);
  });
});

describe("lintBpmnSemantics vs. lintBpmn across graph:layout (issue #106)", () => {
  // local/label-layout reads <bpmndi:*> shapes, same as no-bpmndi -- so it
  // only makes sense once graph:layout has actually run. It only fires for
  // a *named* gateway or event (a task's own label lives inside its bounds),
  // so a document like this one -- a named gateway and a named end event,
  // no DI at all yet -- is exactly what used to trip checkSplice.
  const unlaidOut = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NAMESPACES} id="Defs_1" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="proc_1" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
    <bpmn:exclusiveGateway id="gw" name="Which?"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f2" sourceRef="gw" targetRef="end" />
    <bpmn:endEvent id="end" name="Bailed"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  it("lintBpmnSemantics accepts a named gateway/event with no DI yet", async () => {
    const report = await lintBpmnSemantics(unlaidOut);
    expect(report.errors).toBe(0);
  });

  it("lintBpmn (the full, post-layout ruleset) still rejects the same document before layout has run", async () => {
    // no-bpmndi dominates here (fires per-element the instant there is no
    // diagram at all); local/label-layout itself only fires once a diagram
    // exists but is missing a specific label's bounds -- the doc is still
    // correctly rejected either way.
    const report = await lintBpmn(unlaidOut);
    expect(report.errors).toBeGreaterThan(0);
    expect(report.lines.join("\n")).toContain("no-bpmndi");
  });

  it("lintBpmn accepts it once graph:layout has actually generated DI", async () => {
    const laidOut = await layoutProcess(unlaidOut);
    const report = await lintBpmn(laidOut);
    expect(report.errors).toBe(0);
  });
});
