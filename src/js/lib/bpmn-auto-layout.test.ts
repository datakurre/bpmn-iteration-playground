import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { layoutProcess } from "./bpmn-auto-layout";
import { BpmnModdle } from "bpmn-moddle";
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };
import { Linter } from "bpmnlint";
import NodeResolver from "bpmnlint/lib/resolver/node-resolver.js";
import { labelLayout } from "./bpmn-label-layout";

const LINT_CONFIG = {
  extends: "bpmnlint:recommended",
  rules: {
    "label-required": "warn",
    "no-overlapping-elements": "error",
    "no-disconnected": "error",
    "no-implicit-split": "error",
    "no-implicit-end": "error",
    "no-implicit-start": "error",
    "no-duplicate-sequence-flows": "error",
    "start-event-required": "error",
    "end-event-required": "error",
    "conditional-flows": "error",
    "fake-join": "error",
    "no-inclusive-gateway": "warn",
    "superfluous-gateway": "warn",
    "local/label-layout": "error",
  },
};

function withLocalRules(resolver: any) {
  return {
    resolveRule(pkg: string, ruleName: string) {
      if (pkg === "bpmnlint-plugin-local" && ruleName === "label-layout") return labelLayout;
      return resolver.resolveRule(pkg, ruleName);
    },
    resolveConfig(pkg: string, configName: string) {
      return resolver.resolveConfig(pkg, configName);
    },
  };
}

describe("bpmn-auto-layout", () => {
  const workflowsDir = join(__dirname, "../../../workflows");
  const bundledWorkflows = [
    "session-default.bpmn",
    "shell-demo.bpmn",
    "session-skeleton.bpmn",
    "session-craft.bpmn",
    "craft-graph.bpmn",
    "pi-default-loop.bpmn",
  ];

  for (const filename of bundledWorkflows) {
    it(`produces zero bpmnlint errors on ${filename}`, async () => {
      const filePath = join(workflowsDir, filename);
      const originalXml = readFileSync(filePath, "utf8");
      const laidOutXml = await layoutProcess(originalXml);

      const moddle = new BpmnModdle({ zeebe });
      const { rootElement } = await moddle.fromXML(laidOutXml);

      const linter = new Linter({
        config: LINT_CONFIG,
        resolver: withLocalRules(new NodeResolver()),
      });
      const reports = await linter.lint(rootElement);

      const errors: string[] = [];
      for (const [rule, entries] of Object.entries(reports)) {
        for (const entry of entries as any[]) {
          if (entry.category === "error") {
            errors.push(`${entry.id}: ${entry.message} (${rule})`);
          }
        }
      }

      expect(errors).toEqual([]);
    });

    it(`matches canonical layout geometry for ${filename}`, async () => {
      const filePath = join(workflowsDir, filename);
      const originalXml = readFileSync(filePath, "utf8");
      const laidOutXml = await layoutProcess(originalXml);

      const moddle = new BpmnModdle({ zeebe });
      const origObj = (await moddle.fromXML(originalXml)) as any;
      const newObj = (await moddle.fromXML(laidOutXml)) as any;

      const origShapes = origObj.rootElement.diagrams[0].plane.planeElement.filter(
        (e: any) => e.$type === "bpmndi:BPMNShape",
      );
      const newShapes = newObj.rootElement.diagrams[0].plane.planeElement.filter(
        (e: any) => e.$type === "bpmndi:BPMNShape",
      );

      const newShapeMap = new Map(newShapes.map((s: any) => [s.bpmnElement.id, s]));

      for (const origShape of origShapes) {
        const id = origShape.bpmnElement?.id;
        const newShape: any = newShapeMap.get(id);
        expect(newShape, `Shape ${id} should exist`).toBeDefined();

        expect(newShape.bounds.x, `Shape ${id} x`).toBe(origShape.bounds.x);
        expect(newShape.bounds.y, `Shape ${id} y`).toBe(origShape.bounds.y);
        expect(newShape.bounds.width, `Shape ${id} width`).toBe(origShape.bounds.width);
        expect(newShape.bounds.height, `Shape ${id} height`).toBe(origShape.bounds.height);

        // Labels
        if (origShape.label) {
          expect(newShape.label, `Shape ${id} label should exist`).toBeDefined();
          expect(newShape.label.bounds.x, `Shape ${id} label x`).toBe(origShape.label.bounds.x);
          expect(newShape.label.bounds.y, `Shape ${id} label y`).toBe(origShape.label.bounds.y);
          expect(newShape.label.bounds.width, `Shape ${id} label width`).toBe(origShape.label.bounds.width);
          expect(newShape.label.bounds.height, `Shape ${id} label height`).toBe(origShape.label.bounds.height);
        }
      }
    });
  }

  it("lays out a synthetic linear process with complete labels and clean coordinates", async () => {
    const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_test"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="linear_test" isExecutable="true">
    <bpmn:startEvent id="start_test" name="Start Test">
      <bpmn:outgoing>f1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="task_one" name="Task One">
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:task>
    <bpmn:endEvent id="end_test" name="End Test">
      <bpmn:incoming>f2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start_test" targetRef="task_one" />
    <bpmn:sequenceFlow id="f2" sourceRef="task_one" targetRef="end_test" />
  </bpmn:process>
</bpmn:definitions>`;

    const laidOut = await layoutProcess(rawXml);
    const moddle = new BpmnModdle({ zeebe });
    const { rootElement } = await moddle.fromXML(laidOut);
    const root = rootElement as any;

    const linter = new Linter({
      config: LINT_CONFIG,
      resolver: withLocalRules(new NodeResolver()),
    });
    const reports = await linter.lint(rootElement);
    const errors = Object.values(reports)
      .flat()
      .filter((e: any) => e.category === "error");
    expect(errors).toEqual([]);

    const planeElements = root.diagrams[0].plane.planeElement;
    const startShape = planeElements.find((e: any) => e.bpmnElement?.id === "start_test");
    const taskShape = planeElements.find((e: any) => e.bpmnElement?.id === "task_one");
    const endShape = planeElements.find((e: any) => e.bpmnElement?.id === "end_test");

    expect(startShape.bounds).toMatchObject({ x: 57, y: 52, width: 36, height: 36 });
    expect(startShape.label.bounds).toMatchObject({ x: 30, y: 96, width: 90, height: 20 });
    expect(taskShape.bounds).toMatchObject({ x: 175, y: 30, width: 100, height: 80 });
    expect(endShape.bounds).toMatchObject({ x: 357, y: 52, width: 36, height: 36 });
    expect(endShape.label.bounds).toMatchObject({ x: 330, y: 96, width: 90, height: 20 });
  });

  it("avoids lane collisions by placing gateway labels opposite to vertical flows or shifting", async () => {
    // In session-craft, gw_crafted branches UP to run_default, so label is placed on bottom
    // and gw_more branches DOWN to loop-back continue, so label is placed on top
    const xml = readFileSync("workflows/session-craft.bpmn", "utf8");
    const laidOut = await layoutProcess(xml);
    const moddle = new BpmnModdle({ zeebe });
    const { rootElement } = await moddle.fromXML(laidOut);
    const root = rootElement as any;
    const planeElements = root.diagrams[0].plane.planeElement;

    const gwCrafted = planeElements.find((e: any) => e.bpmnElement?.id === "gw_crafted");
    const gwMore = planeElements.find((e: any) => e.bpmnElement?.id === "gw_more");
    const gwCraftDone = planeElements.find((e: any) => e.bpmnElement?.id === "gw_craft_done");

    // gw_crafted has UP flow, so label is below (y > 185 + 50)
    expect(gwCrafted.label.bounds.y).toBeGreaterThan(185 + 50);

    // gw_more has DOWN flow, so label is above (y < 185)
    expect(gwMore.label.bounds.y).toBeLessThan(185);

    // gw_craft_done has DOWN incoming flow from above, so label is below (y > 185 + 50)
    expect(gwCraftDone.label.bounds.y).toBeGreaterThan(185 + 50);
  });

  it("lays out every bpmn:Process in a multi-process document as its own plane, without dropping or cross-wiring shapes (issue #87)", async () => {
    // Mirrors what linkGraph produces for a real session: a root process
    // with a callActivity plus a second, inlined process it calls -- the
    // shape a session graph is in once graph:extend has spliced into it.
    // layoutProcess used to hand the whole multi-process document to a
    // single-process layout, which discarded the DI for every process past
    // the first and, for whichever survived, mixed shapes from one process
    // onto another's plane.
    const NS =
      'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_multi" ${NS}>
  <bpmn:process id="root_process" isExecutable="true">
    <bpmn:startEvent id="root_start"><bpmn:outgoing>rf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="rf1" sourceRef="root_start" targetRef="root_call" />
    <bpmn:callActivity id="root_call" calledElement="child_process">
      <bpmn:incoming>rf1</bpmn:incoming><bpmn:outgoing>rf2</bpmn:outgoing>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="rf2" sourceRef="root_call" targetRef="root_end" />
    <bpmn:endEvent id="root_end"><bpmn:incoming>rf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmn:process id="child_process" isExecutable="true">
    <bpmn:startEvent id="child_start"><bpmn:outgoing>cf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="cf1" sourceRef="child_start" targetRef="child_task" />
    <bpmn:serviceTask id="child_task" name="Check">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="shell" />
      </bpmn:extensionElements>
      <bpmn:incoming>cf1</bpmn:incoming><bpmn:outgoing>cf2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="cf2" sourceRef="child_task" targetRef="child_end" />
    <bpmn:endEvent id="child_end"><bpmn:incoming>cf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

    const laidOut = await layoutProcess(xml);
    const moddle = new BpmnModdle({ zeebe });
    const { rootElement } = (await moddle.fromXML(laidOut)) as any;

    expect(rootElement.diagrams).toHaveLength(2);

    const planeByProcessId = new Map(rootElement.diagrams.map((d: any) => [d.plane.bpmnElement.id, d.plane]));
    const rootPlane = planeByProcessId.get("root_process") as any;
    const childPlane = planeByProcessId.get("child_process") as any;
    expect(rootPlane, "root_process should have its own plane").toBeDefined();
    expect(childPlane, "child_process should have its own plane").toBeDefined();

    const shapeIds = (plane: any) =>
      plane.planeElement.filter((e: any) => e.$type === "bpmndi:BPMNShape").map((s: any) => s.bpmnElement.id).sort();

    expect(shapeIds(rootPlane)).toEqual(["root_call", "root_end", "root_start"]);
    expect(shapeIds(childPlane)).toEqual(["child_end", "child_start", "child_task"]);
  });

  it("names the problem for a sequence flow that crosses between two processes, instead of crashing on undefined (issue #94)", async () => {
    // applyGraphOps/checkSplice (graph.ts) now refuse to produce this shape,
    // but a hand-written or externally-supplied document could still reach
    // layoutProcess directly -- this used to fail deep in track/waypoint
    // computation with a bare "Cannot read properties of undefined (reading
    // '$type')", naming neither the flow nor why it was malformed.
    const NS =
      'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_cross" ${NS}>
  <bpmn:process id="root_process" isExecutable="true">
    <bpmn:startEvent id="root_start"><bpmn:outgoing>rf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="rf1" sourceRef="root_start" targetRef="root_call" />
    <bpmn:callActivity id="root_call" calledElement="child_process">
      <bpmn:incoming>rf1</bpmn:incoming>
    </bpmn:callActivity>
  </bpmn:process>
  <bpmn:process id="child_process" isExecutable="false">
    <bpmn:startEvent id="child_start" />
    <bpmn:sequenceFlow id="crossing" sourceRef="child_start" targetRef="root_call" />
    <bpmn:endEvent id="child_end" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(layoutProcess(xml)).rejects.toThrow(/crossing.*cannot cross between processes/s);
  });
});
