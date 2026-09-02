import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePaths, paths as resolvePaths } from "./paths.ts";
import { SessionStore } from "./session-store.ts";
import { promoteSession, sanitizeId } from "./promote.ts";

describe("sanitizeId", () => {
  it("sanitizes special characters to underscores", () => {
    expect(sanitizeId("my_graph_name")).toBe("my_graph_name");
    expect(sanitizeId("my graph.name!")).toBe("my_graph_name_");
    expect(sanitizeId("my-graph-name")).toBe("my_graph_name");
  });
});

describe("promoteSession", () => {
  const SAMPLE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_orig" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="orig_process" isExecutable="true">
    <bpmn:startEvent id="start" name="Start">
      <bpmn:outgoing>to_turn</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="to_turn" sourceRef="start" targetRef="turn" />
    <bpmn:serviceTask id="turn" name="Turn">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
      </bpmn:extensionElements>
      <bpmn:incoming>to_turn</bpmn:incoming>
      <bpmn:outgoing>to_end</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="to_end" sourceRef="turn" targetRef="end" />
    <bpmn:endEvent id="end" name="End">
      <bpmn:incoming>to_end</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_orig">
    <bpmndi:BPMNPlane id="BPMNPlane_orig" bpmnElement="orig_process">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <dc:Bounds x="57" y="52" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="turn_di" bpmnElement="turn">
        <dc:Bounds x="175" y="30" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="end_di" bpmnElement="end">
        <dc:Bounds x="350" y="52" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="to_turn_di" bpmnElement="to_turn">
        <di:waypoint x="93" y="70" />
        <di:waypoint x="175" y="70" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="to_end_di" bpmnElement="to_end">
        <di:waypoint x="275" y="70" />
        <di:waypoint x="350" y="70" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  function setup() {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-promote-test-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "test-sess");
    store.create(home);
    store.appendGraph(SAMPLE_BPMN, "initial graph");
    return { home, paths, store };
  }

  it("promotes a session graph to the library", async () => {
    const { paths } = setup();
    const result = await promoteSession({
      paths,
      sessionId: "test-sess",
      name: "promoted_sample",
    });

    expect(result.success).toBe(true);
    expect(result.targetPath).toBe(join(paths.workflowsDir, "promoted_sample.bpmn"));
    expect(existsSync(result.targetPath!)).toBe(true);

    const promotedXml = readFileSync(result.targetPath!, "utf8");
    expect(promotedXml).toContain('id="promoted_sample"');
    expect(promotedXml).toContain('id="Defs_promoted_sample"');
  });

  it("errors on unknown session", async () => {
    const { paths } = setup();
    const result = await promoteSession({
      paths,
      sessionId: "nonexistent",
      name: "target",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown session");
  });

  it("refuses to overwrite existing without force, and backs up with force", async () => {
    const { paths } = setup();
    const targetFile = join(paths.workflowsDir, "existing.bpmn");
    writeFileSync(targetFile, SAMPLE_BPMN);

    const failRes = await promoteSession({
      paths,
      sessionId: "test-sess",
      name: "existing",
      force: false,
    });
    expect(failRes.success).toBe(false);
    expect(failRes.error).toContain("--force");

    const okRes = await promoteSession({
      paths,
      sessionId: "test-sess",
      name: "existing",
      force: true,
    });
    expect(okRes.success).toBe(true);
    expect(existsSync(`${targetFile}.bak`)).toBe(true);
  });
});
