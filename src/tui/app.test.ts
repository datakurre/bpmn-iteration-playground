// @vitest-environment node
import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createNoopToolExecutor } from "../agent/tool-executor.ts";
import { ensurePaths, paths as resolvePaths, type Paths } from "../agent/paths.ts";
import { runSession } from "../agent/runner.ts";
import { startTui, type TuiHandles } from "./app.ts";
import type { Terminal } from "./pi-bridge.ts";

/**
 * `docs/research/06-tui.md` §6: `TuiBase` takes a `Terminal`, a small
 * interface, so a fake that never touches a real pty is enough to drive the
 * app end to end -- start(), stop() and write() do nothing observable to
 * this test; what matters is the rendered `Component` tree, checked through
 * `TuiHandles.root` below.
 */
class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

/**
 * start -> a human gate with one form field -> one `agent:turn` that echoes
 * it back -> end. No model call happens until the gate is answered, and the
 * whole thing settles in one scripted turn -- enough to prove the wizard
 * answers a real parked gate and the run reaches a genuine end event,
 * without needing session-skeleton's own multi-turn craft/lint loop.
 */
const SMOKE_GRAPH = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_tui_smoke" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="tui_smoke" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="gate_form">{"components":[{"key":"value","label":"Say something","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start" name="Start">
      <bpmn:outgoing>to_gate</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="to_gate" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate" name="Say something">
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="gate_form" />
        <zeebe:ioMapping>
          <zeebe:output source="=value" target="value" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>to_gate</bpmn:incoming>
      <bpmn:outgoing>to_turn</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="to_turn" sourceRef="gate" targetRef="turn" />
    <bpmn:serviceTask id="turn" name="Respond">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=value" target="prompt" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>to_turn</bpmn:incoming>
      <bpmn:outgoing>to_end</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="to_end" sourceRef="turn" targetRef="end" />
    <bpmn:endEvent id="end" name="End">
      <bpmn:incoming>to_end</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_tui_smoke">
    <bpmndi:BPMNPlane id="BPMNPlane_tui_smoke" bpmnElement="tui_smoke">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <dc:Bounds x="57" y="52" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="gate_di" bpmnElement="gate">
        <dc:Bounds x="150" y="30" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="turn_di" bpmnElement="turn">
        <dc:Bounds x="300" y="30" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="end_di" bpmnElement="end">
        <dc:Bounds x="450" y="52" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="to_gate_di" bpmnElement="to_gate">
        <di:waypoint x="93" y="70" />
        <di:waypoint x="150" y="70" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="to_turn_di" bpmnElement="to_turn">
        <di:waypoint x="250" y="70" />
        <di:waypoint x="300" y="70" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="to_end_di" bpmnElement="to_end">
        <di:waypoint x="400" y="70" />
        <di:waypoint x="450" y="70" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

/**
 * start -> one `agent:turn` (recorded, so a resume has something to seed
 * its transcript from) -> a human gate -> end. Used by the resume test
 * below: the first leg runs and parks non-interactively, the second
 * reattaches via the TUI.
 */
const RESUME_GRAPH = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_tui_resume" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="tui_resume" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="gate_form">{"components":[{"key":"value","label":"Say something","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start">
      <bpmn:outgoing>to_turn</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="to_turn" sourceRef="start" targetRef="turn" />
    <bpmn:serviceTask id="turn" name="Greet">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>to_turn</bpmn:incoming>
      <bpmn:outgoing>to_gate</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="to_gate" sourceRef="turn" targetRef="gate" />
    <bpmn:userTask id="gate" name="Say something">
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="gate_form" />
        <zeebe:ioMapping>
          <zeebe:output source="=value" target="value" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>to_gate</bpmn:incoming>
      <bpmn:outgoing>to_end</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="to_end" sourceRef="gate" targetRef="end" />
    <bpmn:endEvent id="end">
      <bpmn:incoming>to_end</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

let home: string;
let paths: Paths;
let graphFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "graph-agent-tui-"));
  paths = ensurePaths(
    resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
  );
  graphFile = join(home, "smoke.bpmn");
  writeFileSync(graphFile, SMOKE_GRAPH);
});

describe("graph-agent tui (issue #50)", () => {
  it("prompts a parked gate, answers it from the editor, and reaches an end event", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("Hello from the agent.")], { stopReason: "stop" })] as never);

    let handles: TuiHandles | undefined;
    const outcomePromise = startTui({
      paths,
      project: home,
      start: { kind: "run", graphPath: graphFile, graphLabel: "smoke" },
      model: faux.getModel(),
      modelLabel: "faux",
      systemPrompt: "test agent",
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      tools: createNoopToolExecutor([]),
      terminal: new FakeTerminal(),
      onReady: (ready) => {
        handles = ready;
      },
    });

    await vi.waitFor(() => {
      expect(handles?.root.render(80).join("\n")).toContain("waiting on gate");
    });

    // Answers the gate's one field ("value"), the way a person typing into
    // the editor and pressing enter would -- see TuiAppOptions.onReady's own
    // doc comment for why this skips pi-tui's raw keystroke decoding.
    handles?.editor.onSubmit?.("hello from the gate");

    const result = await outcomePromise;
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");

    const rendered = handles?.root.render(80).join("\n") ?? "";
    expect(rendered).toContain("Hello from the agent.");
    expect(rendered).not.toContain("waiting on gate");
  });
});

describe("graph-agent tui --resume (issue #67)", () => {
  it("reattaches a parked session, shows its prior turn and the parked gate, and answers it", async () => {
    const resumeGraphFile = join(home, "resume.bpmn");
    writeFileSync(resumeGraphFile, RESUME_GRAPH);

    const firstLeg = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    firstLeg.setResponses([fauxAssistantMessage([fauxText("Hello from the first leg.")], { stopReason: "stop" })] as never);

    // Runs and parks non-interactively -- the TUI never touches this leg,
    // the same way a real terminal that Ctrl-Cs or a process that just exits
    // never gets a chance to answer the gate it stopped on either.
    const parked = await runSession({
      paths,
      project: home,
      graphPath: resumeGraphFile,
      prompt: "say hi",
      model: firstLeg.getModel(),
      systemPrompt: "test agent",
      streamFn: (model, context, options) => firstLeg.provider.streamSimple(model, context, options),
      tools: createNoopToolExecutor([]),
      onWait: () => undefined,
    });
    expect(parked.outcome).toBe("stopped");

    const secondLeg = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });

    let handles: TuiHandles | undefined;
    const outcomePromise = startTui({
      paths,
      project: home,
      start: { kind: "resume", sessionId: parked.sessionId },
      model: secondLeg.getModel(),
      modelLabel: "faux",
      systemPrompt: "test agent",
      streamFn: (model, context, options) => secondLeg.provider.streamSimple(model, context, options),
      tools: createNoopToolExecutor([]),
      terminal: new FakeTerminal(),
      onReady: (ready) => {
        handles = ready;
      },
    });

    // The prior leg's own turn shows up immediately, seeded from meta.turns
    // rather than a live event -- and so does the gate it parked on, without
    // this test ever calling `onWait` itself: `resumeSession` re-announces
    // whatever the snapshot is still parked on the moment it resumes.
    await vi.waitFor(() => {
      const rendered = handles?.root.render(80).join("\n") ?? "";
      expect(rendered).toContain("Hello from the first leg");
      expect(rendered).toContain("waiting on gate");
      // The status strip names the session's own graph (issue #73), read
      // back from meta.graph (set at runSession time) rather than showing
      // the literal placeholder "(resumed)".
      expect(rendered).toContain("graph resume ·");
      expect(rendered).not.toContain("(resumed)");
    });

    handles?.editor.onSubmit?.("hello from the reattached gate");

    const result = await outcomePromise;
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(result.sessionId).toBe(parked.sessionId);
  });

  it("handles slash commands and renders user prompts", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("Done.")], { stopReason: "stop" })] as never);

    let handles: TuiHandles | undefined;
    const outcomePromise = startTui({
      paths,
      project: home,
      start: { kind: "run", graphPath: graphFile, graphLabel: "smoke", prompt: "initial user prompt" },
      model: faux.getModel(),
      modelLabel: "faux-model-label",
      systemPrompt: "test agent",
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      tools: createNoopToolExecutor([]),
      terminal: new FakeTerminal(),
      onReady: (ready) => {
        handles = ready;
      },
    });

    await vi.waitFor(() => {
      expect(handles?.root.render(80).join("\n")).toContain("waiting on gate");
    });

    // Test /help command
    handles?.editor.onSubmit?.("/help");
    expect(handles?.root.render(80).join("\n")).toContain("/model");
    expect(handles?.root.render(80).join("\n")).toContain("/sessions");
    expect(handles?.root.render(80).join("\n")).toContain("/studio");
    expect(handles?.root.render(80).join("\n")).toContain("/steer");

    // Test /model command
    handles?.editor.onSubmit?.("/model");
    expect(handles?.root.render(80).join("\n")).toContain("faux-model-label");

    // Test /graph command (shows name and flow outline)
    await handles?.editor.onSubmit?.("/graph");
    expect(handles?.root.render(80).join("\n")).toContain("graph: smoke");
    expect(handles?.root.render(80).join("\n")).toContain("start");
    expect(handles?.root.render(80).join("\n")).toContain("gate  [UserTask: Say something]");

    // Test /graphs command (lists library workflows)
    await handles?.editor.onSubmit?.("/graphs");
    expect(handles?.root.render(80).join("\n")).toContain("Available workflows:");

    // Test /rail command (toggles split rail mode)
    await handles?.editor.onSubmit?.("/rail");
    expect(handles?.root.render(80).join("\n")).toContain("side rail enabled");

    // Test /graph <name> command (shows named graph outline)
    await handles?.editor.onSubmit?.("/graph smoke");
    expect(handles?.root.render(80).join("\n")).toContain("graph: smoke");

    // Test /promote command (promotes active session graph to library)
    await handles?.editor.onSubmit?.("/promote promoted_smoke");
    expect(handles?.root.render(80).join("\n")).toContain("promoted session graph to library");

    // Test /sessions command
    await handles?.editor.onSubmit?.("/sessions");
    expect(handles?.root.render(80).join("\n")).toContain("Recent sessions:");

    // Test unknown slash command error guarding
    handles?.editor.onSubmit?.("/unknown_cmd");
    expect(handles?.root.render(80).join("\n")).toContain("unknown command: /unknown_cmd");

    // Answer gate and finish
    handles?.editor.onSubmit?.("answering gate");
    const result = await outcomePromise;
    expect(result.outcome).toBe("completed");

    const rendered = handles?.root.render(80).join("\n") ?? "";
    expect(rendered).toContain("initial user prompt");
    expect(rendered).toContain("Done.");
  });

  it("waits for interactive prompt in editor when starting without initial prompt", async () => {
    const directGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_tui_direct" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="tui_direct" isExecutable="true">
    <bpmn:startEvent id="start">
      <bpmn:outgoing>to_turn</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="to_turn" sourceRef="start" targetRef="turn" />
    <bpmn:serviceTask id="turn" name="Respond">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>to_turn</bpmn:incoming>
      <bpmn:outgoing>to_end</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="to_end" sourceRef="turn" targetRef="end" />
    <bpmn:endEvent id="end">
      <bpmn:incoming>to_end</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

    const directGraphFile = join(home, "direct.bpmn");
    writeFileSync(directGraphFile, directGraph);

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("Prompt received.")], { stopReason: "stop" })] as never);

    let handles: TuiHandles | undefined;
    const outcomePromise = startTui({
      paths,
      project: home,
      start: { kind: "run", graphPath: directGraphFile, graphLabel: "direct" },
      model: faux.getModel(),
      modelLabel: "faux-model",
      systemPrompt: "test agent",
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      tools: createNoopToolExecutor([]),
      terminal: new FakeTerminal(),
      onReady: (ready) => {
        handles = ready;
      },
    });

    await vi.waitFor(() => {
      expect(handles?.root.render(80).join("\n")).toContain("enter prompt to start");
    });

    handles?.editor.onSubmit?.("my custom prompt from editor");
    const result = await outcomePromise;
    expect(result.outcome).toBe("completed");

    const rendered = handles?.root.render(80).join("\n") ?? "";
    expect(rendered).toContain("my custom prompt from editor");
    expect(rendered).toContain("Prompt received.");
  });

  it("renders diff preview component when gate documentation has unified diff", async () => {
    const diffGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_tui_diff" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="tui_diff" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="review_form">{"components":[{"key":"approved","label":"Approve patch?","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start">
      <bpmn:outgoing>to_gate</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="to_gate" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate" name="Review patch">
      <bpmn:documentation>--- a/index.ts
+++ b/index.ts
@@ -1,3 +1,3 @@
-const oldVal = 1;
+const newVal = 2;</bpmn:documentation>
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="review_form" />
      </bpmn:extensionElements>
      <bpmn:incoming>to_gate</bpmn:incoming>
      <bpmn:outgoing>to_end</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="to_end" sourceRef="gate" targetRef="end" />
    <bpmn:endEvent id="end">
      <bpmn:incoming>to_end</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

    const diffGraphFile = join(home, "diff_review.bpmn");
    writeFileSync(diffGraphFile, diffGraph);

    let handles: TuiHandles | undefined;
    const outcomePromise = startTui({
      paths,
      project: home,
      start: { kind: "run", graphPath: diffGraphFile, graphLabel: "diff_review", prompt: "Review this diff" },
      model: fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] }).getModel(),
      modelLabel: "faux-model",
      systemPrompt: "test agent",
      streamFn: (model, context, options) => fauxProvider({ provider: "faux", models: [{ id: "f", name: "F" }] }).provider.streamSimple(model, context, options),
      tools: createNoopToolExecutor([]),
      terminal: new FakeTerminal(),
      onReady: (ready) => {
        handles = ready;
      },
    });

    await vi.waitFor(() => {
      const rendered = handles?.root.render(80).join("\n") ?? "";
      expect(rendered).toContain("waiting on gate");
      expect(rendered).toContain("const oldVal = 1;");
      expect(rendered).toContain("const newVal = 2;");
    });

    handles?.editor.onSubmit?.("yes");
    const result = await outcomePromise;
    expect(result.outcome).toBe("completed");
  });
});

