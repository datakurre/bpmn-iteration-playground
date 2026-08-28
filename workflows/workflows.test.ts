// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BpmnModdle } from "bpmn-moddle";
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };
import { harnessOf, type ActivityLike } from "../src/agent/zeebe.ts";
import { toSourceContext } from "../src/agent/graph.ts";

const DIR = join(import.meta.dirname);
const files = readdirSync(DIR).filter((f) => f.endsWith(".bpmn"));

async function parse(file: string) {
  const moddle = new BpmnModdle({ zeebe });
  return moddle.fromXML(readFileSync(join(DIR, file), "utf8"));
}

interface FlowElement {
  $type: string;
  id: string;
  name?: string;
  flowElements?: FlowElement[];
  extensionElements?: { values?: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

/**
 * bpmn-moddle hands back the raw XML shape; bpmn-elements wraps each element as
 * `{ id, type, behaviour }` before any extension sees it. camunda7.ts is written
 * against the engine's shape, so adapt here rather than teach it two.
 */
function asActivity(element: FlowElement): ActivityLike {
  return {
    id: element.id,
    type: element.$type,
    ...(element.name === undefined ? {} : { name: element.name }),
    behaviour: element as unknown as ActivityLike["behaviour"],
  };
}

function flatten(elements: FlowElement[] = []): FlowElement[] {
  return elements.flatMap((e) => [e, ...flatten(e.flowElements)]);
}

async function elementsOf(file: string): Promise<FlowElement[]> {
  const { rootElement } = await parse(file);
  const processes = ((rootElement as unknown as { rootElements?: FlowElement[] }).rootElements ?? []).filter(
    (e) => e.$type === "bpmn:Process",
  );
  return processes.flatMap((p) => [p, ...flatten(p.flowElements)]);
}

describe.each(files)("%s", (file) => {
  it("parses and is executable", async () => {
    const elements = await elementsOf(file);
    const processes = elements.filter((e) => e.$type === "bpmn:Process");
    expect(processes.length).toBeGreaterThan(0);
    for (const process of processes) expect(process.isExecutable).toBe(true);
  });

  it("carries diagram interchange, so the studio can render it", () => {
    const xml = readFileSync(join(DIR, file), "utf8");
    expect(xml).toContain("BPMNDiagram");
    expect(xml).toContain("BPMNShape");
  });

  it("loads into the engine's serializer", async () => {
    const context = await toSourceContext(readFileSync(join(DIR, file), "utf8"));
    expect(context.id).toBeTruthy();
  });

  it("gives every service task a job type", async () => {
    const elements = await elementsOf(file);
    const serviceTasks = elements.filter((e) => e.$type === "bpmn:ServiceTask");
    for (const task of serviceTasks) {
      expect(harnessOf(asActivity(task)), `${task.id} has no zeebe:taskDefinition`).toBeTruthy();
    }
  });

  it("puts conditions on gateway flows, never on task flows", async () => {
    const elements = await elementsOf(file);
    const byId = new Map(elements.map((e) => [e.id, e]));
    const flows = elements.filter((e) => e.$type === "bpmn:SequenceFlow");
    for (const flow of flows) {
      if (!flow.conditionExpression) continue;
      const source = byId.get((flow.sourceRef as { id: string }).id);
      expect(source?.$type, `${flow.id} carries a condition but leaves a ${source?.$type}`).toMatch(/Gateway/);
    }
  });

  it("writes conditions as Camunda 8 FEEL", async () => {
    const elements = await elementsOf(file);
    for (const flow of elements.filter((e) => e.$type === "bpmn:SequenceFlow")) {
      const condition = flow.conditionExpression as { body?: string } | undefined;
      if (!condition?.body) continue;
      // Camunda 8 spells an expression `=<feel>`, not `${...}`. This is not
      // cosmetic: bpmn-elements asks isExpression before evaluating a condition,
      // and a condition it does not recognise is a truthy literal, so an
      // unrecognised gateway silently takes every branch.
      expect(condition.body.trimStart().startsWith("="), `${flow.id} is not a FEEL expression`).toBe(true);
      // `==` is JUEL/Python equality; FEEL spells it `=`. Single-quoted strings
      // are not FEEL literals either.
      expect(condition.body, `${flow.id}`).not.toMatch(/==|!==/);
      expect(condition.body, `${flow.id}`).not.toMatch(/'[^']*'/);
    }
  });

  it("uses no Camunda 7 extension elements", () => {
    const xml = readFileSync(join(DIR, file), "utf8");
    expect(xml).not.toMatch(/<camunda:/);
    expect(xml).not.toMatch(/\$\{/);
  });
});

/**
 * pi-default-loop.bpmn claims to be a transcription of runLoop() in
 * @earendil-works/pi-agent-core. A transcription that quietly drops a branch is
 * worse than no diagram at all, so pin the branches that must be present.
 */
describe("pi-default-loop.bpmn is faithful to runLoop()", () => {
  it("represents every decision runLoop makes", async () => {
    const elements = await elementsOf("pi-default-loop.bpmn");
    const ids = new Set(elements.map((e) => e.id));

    for (const [id, why] of [
      ["inject_pending", "getSteeringMessages drain at the top of the inner loop"],
      ["llm_turn", "one streamed assistant response"],
      ["gw_failed", "stopReason error/aborted exits the loop"],
      ["gw_tools", "no tool calls means the inner loop can end"],
      ["gw_truncated", "stopReason length must fail the whole batch"],
      ["fail_tool_batch", "truncated tool calls are failed, never executed"],
      ["tool_batch", "the tool batch itself"],
      ["gw_terminate", "the all-terminate early exit rule"],
      ["prepare_next_turn", "prepareNextTurn"],
      ["gw_should_stop", "shouldStopAfterTurn"],
      ["drain_followup", "getFollowUpMessages, the outer loop"],
      ["gw_followup", "follow-ups restart the inner loop"],
    ] as const) {
      expect(ids.has(id), `missing ${id}: ${why}`).toBe(true);
    }
  });

  it("loops back rather than running straight through", async () => {
    const elements = await elementsOf("pi-default-loop.bpmn");
    const flows = elements.filter((e) => e.$type === "bpmn:SequenceFlow");
    const target = (id: string) =>
      flows.find((f) => f.id === id)?.targetRef as { id: string } | undefined;

    // the inner loop: another turn goes back to the steering drain
    expect(target("next_turn")?.id).toBe("inject_pending");
    // the outer loop: a queued follow-up re-enters the same place
    expect(target("followup_again")?.id).toBe("inject_pending");
  });

  it("aborts with a terminate end event rather than an ordinary one", async () => {
    const elements = await elementsOf("pi-default-loop.bpmn");
    const end = elements.find((e) => e.id === "end_error") as
      | { eventDefinitions?: Array<{ $type: string }> }
      | undefined;
    expect(end?.eventDefinitions?.[0]?.$type).toBe("bpmn:TerminateEventDefinition");
  });

  it("runs the tool batch as a multi-instance subprocess", async () => {
    const elements = await elementsOf("pi-default-loop.bpmn");
    const batch = elements.find((e) => e.id === "tool_batch") as
      | { loopCharacteristics?: { $type: string; isSequential?: boolean } }
      | undefined;
    expect(batch?.loopCharacteristics?.$type).toBe("bpmn:MultiInstanceLoopCharacteristics");
    // Pi's default toolExecution is "parallel"
    expect(batch?.loopCharacteristics?.isSequential).toBe(false);
  });
});
