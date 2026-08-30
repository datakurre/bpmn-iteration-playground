// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BpmnModdle } from "bpmn-moddle";
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };
import { activityProperties, harnessOf, ioMapping, type ActivityLike } from "../src/agent/zeebe.ts";
import { toSourceContext } from "../src/agent/graph.ts";
import { createHarnesses, harnessIOContract, type HarnessDeps } from "../src/agent/harnesses.ts";

const DIR = join(import.meta.dirname);
const files = readdirSync(DIR).filter((f) => f.endsWith(".bpmn"));

// Every job type this build can actually dispatch to -- the same set
// checkSplice checks a drafted fragment against (issue #40). A hand-authored
// graph in this directory should not be able to ship a dead job type either.
const REGISTERED_JOB_TYPES = new Set(
  Object.keys(
    createHarnesses({
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store: {} as HarnessDeps["store"],
      getGraph: () => "",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    }),
  ),
);

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

  it("names a job type some harness actually handles", async () => {
    const elements = await elementsOf(file);
    const serviceTasks = elements.filter((e) => e.$type === "bpmn:ServiceTask");
    for (const task of serviceTasks) {
      const jobType = harnessOf(asActivity(task));
      expect(jobType && REGISTERED_JOB_TYPES.has(jobType), `${task.id} names '${jobType}', which no harness handles`).toBe(
        true,
      );
    }
  });

  it("wires each service task's I/O the way its harness actually reads/publishes (issue #65)", async () => {
    const elements = await elementsOf(file);
    const serviceTasks = elements.filter((e) => e.$type === "bpmn:ServiceTask");
    const contract = harnessIOContract();
    for (const task of serviceTasks) {
      const activity = asActivity(task);
      const jobType = harnessOf(activity);
      const io = jobType ? contract[jobType] : undefined;
      if (!io) continue; // an unregistered job type is already asserted above

      const mapping = ioMapping(activity);
      for (const { target } of mapping.input) {
        if (target === undefined) continue;
        expect(io.inputs ?? [], `${task.id} maps input '${target}', which '${jobType}' never reads`).toContain(
          target,
        );
      }
      for (const key of Object.keys(activityProperties(activity))) {
        expect(io.headers ?? [], `${task.id} sets header '${key}', which '${jobType}' never reads`).toContain(key);
      }
      for (const { source } of mapping.output) {
        // Only a bare field reference (`=exit_code`) is checkable here -- a
        // graph may legitimately write a FEEL literal or expression instead
        // (pi-default-loop.bpmn's llm_turn resets `prompt` to `=null` once
        // consumed, not reading a result field at all).
        const field = /^=(?!null$|true$|false$)([A-Za-z_][A-Za-z0-9_]*)$/.exec(source ?? "")?.[1];
        if (field === undefined) continue;
        expect(io.outputs ?? [], `${task.id} reads output '${field}', which '${jobType}' never publishes`).toContain(
          field,
        );
      }
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

  it("cannot strand the token at an exclusive gateway", async () => {
    // FEEL is total, so a missing variable yields null or false rather than an
    // error: `count(tool_calls) > 0` is null and `count(tool_calls) = 0` is false
    // when tool_calls is unset, leaving an exclusive gateway with no satisfied
    // outgoing flow and the token stuck. A default flow is the only guarantee
    // that some branch is always taken.
    const elements = await elementsOf(file);
    const flows = elements.filter((e) => e.$type === "bpmn:SequenceFlow");
    for (const gateway of elements.filter((e) => e.$type === "bpmn:ExclusiveGateway")) {
      const outgoing = flows.filter((f) => (f.sourceRef as { id: string }).id === gateway.id);
      if (outgoing.length < 2) continue;
      const unconditional = outgoing.filter((f) => !f.conditionExpression);
      const hasDefault = gateway.default !== undefined;
      expect(
        hasDefault || unconditional.length > 0,
        `${gateway.id} has ${outgoing.length} conditional outgoing flows and no default`,
      ).toBe(true);
    }
  });

  it("wires incoming and outgoing references to flows that exist", async () => {
    // A dangling <bpmn:incoming> is invisible to bpmnlint but leaves the graph
    // referring to a flow that no longer arrives.
    const elements = await elementsOf(file);
    const flowIds = new Set(
      elements.filter((e) => e.$type === "bpmn:SequenceFlow").map((f) => f.id),
    );
    for (const element of elements) {
      for (const key of ["incoming", "outgoing"] as const) {
        const refs = (element[key] ?? []) as Array<{ id: string }>;
        for (const ref of refs) {
          expect(flowIds.has(ref.id), `${element.id} ${key} references missing flow ${ref.id}`).toBe(true);
        }
      }
    }
  });

  it("wires every sequence flow between elements that exist", async () => {
    const elements = await elementsOf(file);
    const ids = new Set(elements.map((e) => e.id));
    for (const flow of elements.filter((e) => e.$type === "bpmn:SequenceFlow")) {
      for (const end of ["sourceRef", "targetRef"] as const) {
        const ref = flow[end] as { id: string } | undefined;
        expect(ref && ids.has(ref.id), `${flow.id} ${end} points at a missing element`).toBe(true);
      }
    }
  });

  it("has something produce every variable its gateways route on", async () => {
    // batch_terminate was read by a gateway that nothing ever wrote, so the
    // branch was dead; session_done was the same bug in another graph. Checking
    // only one graph missed the second, so this runs over all of them.
    const elements = await elementsOf(file);
    const produced = new Set<string>(["prompt"]);
    for (const element of elements) {
      const io = element.extensionElements?.values?.find((v) => v.$type === "zeebe:IoMapping") as
        | { outputParameters?: Array<{ target?: string }> }
        | undefined;
      for (const out of io?.outputParameters ?? []) if (out.target) produced.add(out.target);
    }
    const read = new Set<string>();
    for (const flow of elements.filter((e) => e.$type === "bpmn:SequenceFlow")) {
      const body = (flow.conditionExpression as { body?: string } | undefined)?.body;
      if (!body) continue;
      // Strip string literals first, or `stop_reason = "error"` reads as a
      // reference to a variable called `error`.
      const withoutLiterals = body.replace(/"[^"]*"/g, '""');
      for (const name of withoutLiterals.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        const word = name[0];
        if (["and", "or", "not", "true", "false", "null", "count", "in", "if", "then", "else"].includes(word)) continue;
        read.add(word);
      }
    }
    for (const name of read) {
      expect(produced.has(name), `gateways route on '${name}' but nothing publishes it`).toBe(true);
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
      ["collect_batch", "tool results are appended and the all-terminate rule computed"],
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

  it("gives each tool-batch instance the tool call it is meant to run", async () => {
    // A bare loopCardinality spawns the right number of instances and tells none
    // of them which tool call is theirs; the batch has to loop over a collection.
    const elements = await elementsOf("pi-default-loop.bpmn");
    const batch = elements.find((e) => e.id === "tool_batch") as
      | { loopCharacteristics?: { extensionElements?: { values?: Array<Record<string, unknown>> } } }
      | undefined;
    const loop = batch?.loopCharacteristics?.extensionElements?.values?.find(
      (v) => v.$type === "zeebe:LoopCharacteristics",
    );
    expect(loop?.inputCollection, "tool_batch does not loop over tool_calls").toBe("=tool_calls");
    expect(loop?.inputElement).toBe("tool_call");

    const runTool = elements.find((e) => e.id === "run_tool") as FlowElement | undefined;
    const io = runTool?.extensionElements?.values?.find((v) => v.$type === "zeebe:IoMapping") as
      | { inputParameters?: Array<{ source?: string; target?: string }> }
      | undefined;
    expect(io?.inputParameters?.some((p) => p.target === "tool_call"), "run_tool never receives its tool call").toBe(
      true,
    );
  });

  it("feeds the prompt into the turn", async () => {
    const elements = await elementsOf("pi-default-loop.bpmn");
    const turn = elements.find((e) => e.id === "llm_turn") as FlowElement | undefined;
    const io = turn?.extensionElements?.values?.find((v) => v.$type === "zeebe:IoMapping") as
      | { inputParameters?: Array<{ target?: string }> }
      | undefined;
    expect(io?.inputParameters?.some((p) => p.target === "prompt")).toBe(true);
  });

});

describe("session-default.bpmn (issue #47)", () => {
  it("reaches pi_default_loop through a callActivity, not an inlined copy", async () => {
    // The whole point of a *composed* default is that pi_default_loop stays a
    // graph a callActivity points at -- pinning this so the composition
    // cannot be quietly inlined later without a test noticing.
    const elements = await elementsOf("session-default.bpmn");
    const callActivities = elements.filter((e) => e.$type === "bpmn:CallActivity") as Array<
      FlowElement & { calledElement?: string }
    >;
    expect(callActivities.some((c) => c.calledElement === "pi_default_loop")).toBe(true);
    // Not a second copy of the loop's own elements living in this file too.
    expect(elements.some((e) => e.id === "llm_turn")).toBe(false);
  });

  it("does not inline pi_default_loop as an executable process", async () => {
    const elements = await elementsOf("session-default.bpmn");
    const processes = elements.filter((e) => e.$type === "bpmn:Process");
    expect(processes.map((p) => p.id)).toEqual(["session_default"]);
  });
});
