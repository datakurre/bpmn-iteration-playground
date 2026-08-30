// @vitest-environment node
import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createNoopToolExecutor } from "../agent/tool-executor.ts";
import { ensurePaths, paths as resolvePaths, type Paths } from "../agent/paths.ts";
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
<bpmn:definitions id="Defs_tui_smoke" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="tui_smoke" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="gate_form">{"components":[{"key":"value","label":"Say something","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start">
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
      graphPath: graphFile,
      graphLabel: "smoke",
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
