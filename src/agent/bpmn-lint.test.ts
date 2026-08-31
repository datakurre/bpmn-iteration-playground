import { describe, it, expect } from "vitest";
import { layoutProcess } from "bpmn-auto-layout";
import { lintBpmn } from "./bpmn-lint.ts";

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
      <bpmn:startEvent id="start" name="Start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:endEvent id="end" name="End"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
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
