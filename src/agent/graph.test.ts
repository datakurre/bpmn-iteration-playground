// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Engine } from "bpmn-engine";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BpmnModdle } from "bpmn-moddle";
import {
  applyGraphOps,
  checkMigration,
  checkSplice,
  definitionsId,
  elementIds,
  firstActivity,
  pendingGates,
  recoverWithGraph,
  stripEmbeddedSource,
  toSourceContext,
  withDefinitionsId,
  type EngineConstructor,
  type EngineState,
  type GraphOp,
} from "./graph.ts";

const EngineCtor = Engine as unknown as EngineConstructor;

/** v1: start -> gate (user task) -> end */
const v1 = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_session" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <process id="session" isExecutable="true">
    <startEvent id="start"><outgoing>f1</outgoing></startEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" name="await turn"><incoming>f1</incoming><outgoing>f2</outgoing></userTask>
    <sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <endEvent id="end"><incoming>f2</incoming></endEvent>
  </process>
</definitions>`;

/** v2: the same graph with a service task spliced between gate and end. */
const v2 = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_session" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <process id="session" isExecutable="true">
    <startEvent id="start"><outgoing>f1</outgoing></startEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" name="await turn"><incoming>f1</incoming><outgoing>f2</outgoing></userTask>
    <sequenceFlow id="f2" sourceRef="gate" targetRef="spliced" />
    <serviceTask id="spliced" name="agent turn" implementation="\${environment.services.turn}">
      <extensionElements>
        <camunda:properties><camunda:property name="harness" value="agent:turn" /></camunda:properties>
      </extensionElements>
      <incoming>f2</incoming>
      <outgoing>f3</outgoing>
    </serviceTask>
    <sequenceFlow id="f3" sourceRef="spliced" targetRef="end" />
    <endEvent id="end"><incoming>f3</incoming></endEvent>
  </process>
</definitions>`;

/** Run v1 until it parks on the user task, then snapshot. */
async function parkedSnapshot(): Promise<EngineState> {
  const engine = new EngineCtor({ name: "session", source: v1 });
  const listener = new EventEmitter();
  const parked = new Promise<void>((resolve) => listener.once("activity.wait", () => resolve()));
  await engine.execute({ listener });
  await parked;
  await engine.stop();
  return engine.getState();
}

describe("graph mutation", () => {
  it("embeds the source in a snapshot, which stripEmbeddedSource removes", async () => {
    const state = await parkedSnapshot();
    expect(state.definitions?.[0]?.source).toBeTypeOf("string");
    expect(stripEmbeddedSource(state).definitions?.[0]?.source).toBeUndefined();
  });

  it("resumes a parked session against a graph that gained a node", async () => {
    const state = await parkedSnapshot();

    const executed: string[] = [];
    const engine = await recoverWithGraph(EngineCtor, state, v2, {
      name: "session",
      services: { turn: (_scope: unknown, callback: (e: unknown, r: unknown) => void) => callback(null, { ok: true }) },
    });

    const listener = new EventEmitter();
    listener.on("activity.wait", (api: { signal: () => void }) => api.signal());
    listener.on("activity.end", (api: { id: string }) => executed.push(api.id));

    const ended = engine.waitFor("end");
    await engine.resume({ listener });
    await ended;

    // The token was standing on `gate` when the graph did not yet contain
    // `spliced`; after the swap it walks straight into the new node.
    expect(executed).toEqual(["gate", "spliced", "end"]);
  });

  it("refuses a replacement graph whose definitions id changed", async () => {
    const state = await parkedSnapshot();
    const renamed = v2.replace('id="Defs_session"', 'id="Defs_other"');
    await expect(recoverWithGraph(EngineCtor, state, renamed, { name: "session" })).rejects.toThrow(
      /must stay stable/,
    );
  });
});

describe("checkSplice", () => {
  it("accepts an additive splice and reports what was added", async () => {
    const result = await checkSplice(v1, v2);
    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual(["f3", "spliced"]);
    expect(result.removed).toEqual([]);
  });

  it("rejects a mutation that drops an element carrying live state", async () => {
    const withoutGate = v1.replace('<userTask id="gate" name="await turn"><incoming>f1</incoming><outgoing>f2</outgoing></userTask>', "");
    const result = await checkSplice(v1, withoutGate);
    expect(result.ok).toBe(false);
    expect(result.removed).toContain("gate");
    expect(result.reason).toMatch(/additive/);
  });

  it("rejects a rename, which reads as a removal plus an addition", async () => {
    const renamed = v1.replace('id="gate"', 'id="gate2"').replace('targetRef="gate"', 'targetRef="gate2"');
    const result = await checkSplice(v1, renamed);
    expect(result.ok).toBe(false);
    expect(result.removed).toContain("gate");
  });
});

describe("checkSplice with a known job-type set (issue #40)", () => {
  // A new service task, zeebe-flavored like the real graphs -- camunda:properties
  // (v1/v2 above) predates the project's actual Camunda 8 convention.
  function withNewTask(jobType: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="run_it" />
    <bpmn:serviceTask id="run_it">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="${jobType}" />
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="run_it" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
  }
  const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;
  const known = new Set(["shell", "agent:turn"]);

  it("accepts a new service task whose job type is registered", async () => {
    const result = await checkSplice(base, withNewTask("shell"), known);
    expect(result.ok).toBe(true);
  });

  it("rejects a new service task naming a job type nothing handles", async () => {
    const result = await checkSplice(base, withNewTask("shell:exec"), known);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/'shell:exec'/);
    expect(result.reason).toMatch(/shell/);
    expect(result.reason).toMatch(/agent:turn/);
  });

  it("rejects a new service task with no taskDefinition at all", async () => {
    const noType = withNewTask("shell").replace(/<zeebe:taskDefinition[^/]*\/>/, "");
    const result = await checkSplice(base, noType, known);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no zeebe:taskDefinition/);
  });

  it("does not check job type when no known set is given -- existing callers are unaffected", async () => {
    const result = await checkSplice(base, withNewTask("shell:exec"));
    expect(result.ok).toBe(true);
  });

  it("does not re-validate an existing service task that was already there", async () => {
    // Only *new* activities are checked -- an existing one already ran once as
    // part of a graph someone approved.
    const already = withNewTask("shell:exec");
    const result = await checkSplice(already, already, known);
    expect(result.ok).toBe(true);
  });
});

describe("checkSplice validates a new activity's I/O against a harness contract (issue #65)", () => {
  const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;
  const known = new Set(["shell"]);
  // The exact contract shape harnesses.ts's harnessIOContract() would build for
  // 'shell', minus the base result fields (irrelevant to this shell-shaped
  // fixture, which only maps 'exit_code'/'command').
  const shellIO = { shell: { headers: ["command", "fail_on_error"], outputs: ["exit_code", "stdout", "stderr"] } };

  function withTask(ioMapping: string, headers = ""): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="t" />
    <bpmn:serviceTask id="t">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="shell" />
        ${headers}
        ${ioMapping}
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
  }

  // issue #65's own repro: a registered job type ('shell'), wired the wrong
  // way -- the command mapped through zeebe:input (shell reads it from
  // zeebe:taskHeaders instead) and the exit status read back under the
  // wrong name ('exitCode' rather than 'exit_code').
  const miswired = withTask(
    `<zeebe:ioMapping>
      <zeebe:input source='="npm test"' target="command" />
      <zeebe:output source="=exitCode" target="rc" />
    </zeebe:ioMapping>`,
  );

  it("accepts a correctly wired activity", async () => {
    const wired = withTask(
      `<zeebe:ioMapping><zeebe:output source="=exit_code" target="rc" /></zeebe:ioMapping>`,
      `<zeebe:taskHeaders><zeebe:header key="command" value="npm test" /></zeebe:taskHeaders>`,
    );
    const result = await checkSplice(base, wired, known, shellIO);
    expect(result.ok).toBe(true);
  });

  it("rejects a zeebe:input mapped to a name the harness never reads", async () => {
    const result = await checkSplice(base, miswired, known, shellIO);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/t maps input 'command'/);
    expect(result.reason).toMatch(/'shell' never reads/);
    // 'shell' has no zeebe:input contract at all (shellIO above declares no
    // `inputs` key) -- the message reads as a sentence naming that, not the
    // placeholder "valid zeebe:input targets: no zeebe:input" an earlier
    // version of this check produced for an empty list (issue #73).
    expect(result.reason).toMatch(/'shell' reads no zeebe:input at all/);
  });

  it("rejects a zeebe:output reading a field the harness never publishes", async () => {
    // The input mistake is fixed (moved to a header, where 'shell' actually
    // reads it) so this isolates the *other* mistake -- the wrong output name.
    const wrongOutputOnly = withTask(
      `<zeebe:ioMapping><zeebe:output source="=exitCode" target="rc" /></zeebe:ioMapping>`,
      `<zeebe:taskHeaders><zeebe:header key="command" value="npm test" /></zeebe:taskHeaders>`,
    );
    const result = await checkSplice(base, wrongOutputOnly, known, shellIO);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/t reads output 'exitCode'/);
    expect(result.reason).toMatch(/valid outputs are: exit_code, stdout, stderr/);
  });

  it("rejects a zeebe:taskHeaders key the harness never reads", async () => {
    const wrongHeader = withTask(
      `<zeebe:ioMapping><zeebe:output source="=exit_code" target="rc" /></zeebe:ioMapping>`,
      `<zeebe:taskHeaders><zeebe:header key="cmd" value="npm test" /></zeebe:taskHeaders>`,
    );
    const result = await checkSplice(base, wrongHeader, known, shellIO);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/t sets header 'cmd'/);
  });

  it("does not check I/O when no contract is given -- existing callers are unaffected", async () => {
    const result = await checkSplice(base, miswired, known);
    expect(result.ok).toBe(true);
  });

  it("does not re-validate an existing activity's I/O -- only newly added ones", async () => {
    const result = await checkSplice(miswired, miswired, known, shellIO);
    expect(result.ok).toBe(true);
  });

  it("skips a zeebe:output that is a FEEL literal or expression, not a bare field reference", async () => {
    // pi-default-loop.bpmn's own llm_turn resets 'prompt' to '=null' once
    // consumed -- a legitimate output binding this check has no business
    // second-guessing, since it names no result field at all.
    const literalOutput = withTask(
      `<zeebe:ioMapping><zeebe:output source="=null" target="rc" /></zeebe:ioMapping>`,
      `<zeebe:taskHeaders><zeebe:header key="command" value="npm test" /></zeebe:taskHeaders>`,
    );
    const result = await checkSplice(base, literalOutput, known, shellIO);
    expect(result.ok).toBe(true);
  });

  it("the redraft loop can recover one mistake at a time, via lint_feedback's own shape", async () => {
    // Round 1: both mistakes present -- rejected on the first one checked (input).
    const round1 = await checkSplice(base, miswired, known, shellIO);
    expect(round1.ok).toBe(false);
    expect(round1.reason).toMatch(/'command'/);

    // Round 2: the model "redrafts" from that feedback, fixing only the input
    // mistake (moving 'command' to a header) -- the output mistake remains.
    const round2Fragment = withTask(
      `<zeebe:ioMapping><zeebe:output source="=exitCode" target="rc" /></zeebe:ioMapping>`,
      `<zeebe:taskHeaders><zeebe:header key="command" value="npm test" /></zeebe:taskHeaders>`,
    );
    const round2 = await checkSplice(base, round2Fragment, known, shellIO);
    expect(round2.ok).toBe(false);
    expect(round2.reason).toMatch(/'exitCode'/);

    // Round 3: both fixed -- accepted.
    const round3Fragment = withTask(
      `<zeebe:ioMapping><zeebe:output source="=exit_code" target="rc" /></zeebe:ioMapping>`,
      `<zeebe:taskHeaders><zeebe:header key="command" value="npm test" /></zeebe:taskHeaders>`,
    );
    const round3 = await checkSplice(base, round3Fragment, known, shellIO);
    expect(round3.ok).toBe(true);
  });
});

describe("checkMigration (issue #46)", () => {
  it("accepts deleting an element the token has never reached, unlike checkSplice", async () => {
    const withoutGate = v1.replace('<userTask id="gate" name="await turn"><incoming>f1</incoming><outgoing>f2</outgoing></userTask>', "");
    // checkSplice rejects this outright -- gate is a real removal.
    expect((await checkSplice(v1, withoutGate)).ok).toBe(false);
    // checkMigration allows it as long as "gate" never carried live state.
    const result = await checkMigration(v1, withoutGate, new Set());
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("rejects deleting an element that does carry live state", async () => {
    const withoutGate = v1.replace('<userTask id="gate" name="await turn"><incoming>f1</incoming><outgoing>f2</outgoing></userTask>', "");
    const result = await checkMigration(v1, withoutGate, new Set(["gate"]));
    expect(result.ok).toBe(false);
    expect(result.removed).toEqual(["gate"]);
    expect(result.reason).toMatch(/live state/);
  });

  it("rejects a rename of a live element the same way", async () => {
    const renamed = v1.replace('id="gate"', 'id="gate2"').replace('targetRef="gate"', 'targetRef="gate2"');
    const result = await checkMigration(v1, renamed, new Set(["gate"]));
    expect(result.ok).toBe(false);
    expect(result.removed).toContain("gate");
  });

  it("accepts an additive edit exactly like checkSplice does", async () => {
    const result = await checkMigration(v1, v2, new Set(["gate"]));
    expect(result.ok).toBe(true);
  });

  it("rejects a changed <bpmn:definitions id>", async () => {
    const rebased = await withDefinitionsId(v1, "Defs_other");
    const result = await checkMigration(v1, rebased, new Set());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/definitions id/);
  });

  it("applies the same job-type contract checkSplice does to a genuinely new activity", async () => {
    const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;
    const withBadTask = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="run_it" />
    <bpmn:serviceTask id="run_it">
      <bpmn:extensionElements><zeebe:taskDefinition type="shell:exec" /></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="run_it" targetRef="end" />
    <bpmn:endEvent id="end" />
  </bpmn:process>
</bpmn:definitions>`;
    const result = await checkMigration(base, withBadTask, new Set(), new Set(["shell"]));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/'shell:exec'/);
  });
});

describe("pendingGates (issue #51)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
  const withGate = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_session" ${NS}>
  <bpmn:process id="session" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="intent_form">{"components":[{"key":"intent","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start" />
    <bpmn:userTask id="gate" name="What next?">
      <bpmn:documentation>Say what you want done.</bpmn:documentation>
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="intent_form" />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:serviceTask id="turn">
      <bpmn:extensionElements><zeebe:taskDefinition type="agent:turn" /></bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

  it("resolves a user task's name, documentation and form schema", async () => {
    const [gate] = await pendingGates(withGate, ["gate"]);
    expect(gate?.id).toBe("gate");
    expect(gate?.name).toBe("What next?");
    expect(gate?.documentation).toBe("Say what you want done.");
    expect(gate?.form?.formId).toBe("intent_form");
    expect(JSON.parse(gate?.form?.schema ?? "{}")).toEqual({ components: [{ key: "intent", type: "textfield" }] });
  });

  it("excludes a token that is not a user task", async () => {
    const gates = await pendingGates(withGate, ["turn"]);
    expect(gates).toEqual([]);
  });

  it("omits form when formId does not resolve to a defined form", async () => {
    const noForm = withGate.replace('formId="intent_form"', 'formId="missing"');
    const [gate] = await pendingGates(noForm, ["gate"]);
    expect(gate?.form).toBeUndefined();
  });

  it("returns nothing for an id that is not in the graph at all", async () => {
    expect(await pendingGates(withGate, ["nope"])).toEqual([]);
  });
});

describe("definitionsId / withDefinitionsId (issue #55)", () => {
  it("reads and rewrites <bpmn:definitions id>", async () => {
    expect(await definitionsId(v1)).toBe("Defs_session");
    const rebased = await withDefinitionsId(v1, "Defs_promoted");
    expect(await definitionsId(rebased)).toBe("Defs_promoted");
    // Semantics otherwise unchanged.
    expect((await elementIds(rebased)).size).toBe((await elementIds(v1)).size);
  });
});

describe("elementIds", () => {
  it("collects flow element ids, plus the definitions and process ids", async () => {
    const ids = await elementIds(v1);
    expect([...ids].sort()).toEqual(["Defs_session", "end", "f1", "f2", "gate", "session", "start"]);
  });
});

describe("toSourceContext", () => {
  it("keys the context on the definitions id, which recovery matches on", async () => {
    expect((await toSourceContext(v1)).id).toBe("Defs_session");
  });
});

describe("checkSplice with an element-type allowlist", () => {
  const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;
  const allowed = new Set(["bpmn:StartEvent", "bpmn:SequenceFlow", "bpmn:ServiceTask", "bpmn:EndEvent"]);

  function withGateway(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
    <bpmn:exclusiveGateway id="gw"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="f2" sourceRef="gw" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
  }
  function withServiceTask(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="t" />
    <bpmn:serviceTask id="t"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
  }

  it("accepts a new element whose type is allowed", async () => {
    const result = await checkSplice(base, withServiceTask(), undefined, undefined, allowed);
    expect(result.ok).toBe(true);
  });

  it("rejects a new element whose type is not allowed, naming the allowed set", async () => {
    const result = await checkSplice(base, withGateway(), undefined, undefined, allowed);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/bpmn:ExclusiveGateway/);
    expect(result.reason).toMatch(/bpmn:ServiceTask/);
  });

  it("does not check element types when no allowlist is given -- existing callers are unaffected", async () => {
    const result = await checkSplice(base, withGateway());
    expect(result.ok).toBe(true);
  });

  it("does not re-validate an existing element's type -- only newly added ones", async () => {
    const already = withGateway();
    const result = await checkSplice(already, already, undefined, undefined, allowed);
    expect(result.ok).toBe(true);
  });

  it("checkMigration applies the same allowlist to a genuinely new element", async () => {
    const result = await checkMigration(base, withGateway(), new Set(), undefined, undefined, allowed);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/bpmn:ExclusiveGateway/);
  });
});

describe("applyGraphOps", () => {
  const NS = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
  const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate"><bpmn:incoming>f1</bpmn:incoming></bpmn:userTask>
  </bpmn:process>
</bpmn:definitions>`;

  it("appendShape adds a new node wired from an existing one, reported as additive by checkSplice", async () => {
    const ops: GraphOp[] = [{ op: "appendShape", type: "bpmn:ServiceTask", id: "run_it", after: "gate" }];
    const merged = await applyGraphOps(base, ops);
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.added.sort()).toEqual(["Flow_ops_1", "run_it"]);
  });

  it("setTaskDefinition wires zeebe:taskDefinition/ioMapping onto a node created earlier in the same batch", async () => {
    const ops: GraphOp[] = [
      { op: "appendShape", type: "bpmn:ServiceTask", id: "run_it", after: "gate" },
      {
        op: "setTaskDefinition",
        id: "run_it",
        jobType: "shell",
        headers: { command: "npm test" },
        outputs: [{ source: "=exit_code", target: "rc" }],
      },
    ];
    const merged = await applyGraphOps(base, ops);
    expect(merged).toContain('<zeebe:taskDefinition type="shell"');
    expect(merged).toContain('key="command"');
    expect(merged).toContain('target="rc"');
    const result = await checkSplice(base, merged, new Set(["shell"]));
    expect(result.ok).toBe(true);
  });

  it("insertShape splices a step into an existing flow, keeping the flow's own id", async () => {
    const ops: GraphOp[] = [{ op: "insertShape", type: "bpmn:ServiceTask", id: "mid", into: "f1" }];
    const merged = await applyGraphOps(base, ops);
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    // f1 (start -> mid) keeps its id; only the new node and the new
    // mid -> gate flow are genuinely additive.
    expect(result.added.sort()).toEqual(["Flow_ops_1", "mid"]);
    expect(merged).toMatch(/<bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="mid"/);
  });

  it("insertShape honours an explicit flowId for its auto-created continuation flow (issue #107)", async () => {
    const ops: GraphOp[] = [{ op: "insertShape", type: "bpmn:ServiceTask", id: "mid", into: "f1", flowId: "named_flow" }];
    const merged = await applyGraphOps(base, ops);
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual(["mid", "named_flow"]);
    expect(merged).toMatch(/<bpmn:sequenceFlow id="named_flow" sourceRef="mid" targetRef="gate"/);
  });

  it("connect wires two nodes created earlier in the same op list", async () => {
    // A real diamond, not two parallel flows onto the same plain end event:
    // "connect" adds gw's second branch straight into "merge", which -- being
    // a gateway -- genuinely joins it with the branch routed through "b1"
    // (issue #104: two incoming into a plain node would be a fake join).
    const ops: GraphOp[] = [
      { op: "appendShape", type: "bpmn:ExclusiveGateway", id: "gw", after: "gate" },
      { op: "appendShape", type: "bpmn:ServiceTask", id: "b1", after: "gw" },
      { op: "appendShape", type: "bpmn:ExclusiveGateway", id: "merge", after: "b1" },
      { op: "appendShape", type: "bpmn:EndEvent", id: "a_end", after: "merge" },
      { op: "connect", from: "gw", to: "merge", id: "extra_flow" },
    ];
    const merged = await applyGraphOps(base, ops);
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual([
      "Flow_ops_1",
      "Flow_ops_2",
      "Flow_ops_3",
      "Flow_ops_4",
      "a_end",
      "b1",
      "extra_flow",
      "gw",
      "merge",
    ]);
  });

  it("createProcess + insertShape(CallActivity) adds a sibling process reachable by calledElement", async () => {
    const ops: GraphOp[] = [
      { op: "createProcess", id: "sub_graph" },
      { op: "insertShape", type: "bpmn:CallActivity", id: "call_sub", into: "f1", calledElement: "sub_graph" },
    ];
    const merged = await applyGraphOps(base, ops);
    expect(merged).toContain('<bpmn:process id="sub_graph"');
    expect(merged).toContain('isExecutable="false"');
    expect(merged).toMatch(/<bpmn:callActivity id="call_sub"[^>]*calledElement="sub_graph"/);
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toContain("sub_graph");
    expect(result.added).toContain("call_sub");
  });

  describe("attaches into the process the target already lives in, not always the executable one (issue #94)", () => {
    // A linked session document, the shape linkGraph produces for a real
    // session: a root (executable) process plus a second, inlined process
    // brought in via calledElement and marked isExecutable="false".
    const linkedBase = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="root_start" />
    <bpmn:sequenceFlow id="rf1" sourceRef="root_start" targetRef="call" />
    <bpmn:callActivity id="call" calledElement="craft_graph" />
    <bpmn:sequenceFlow id="rf2" sourceRef="call" targetRef="root_end" />
    <bpmn:endEvent id="root_end" />
  </bpmn:process>
  <bpmn:process id="craft_graph" isExecutable="false">
    <bpmn:startEvent id="craft_start" />
    <bpmn:sequenceFlow id="cf1" sourceRef="craft_start" targetRef="craft_end" />
    <bpmn:endEvent id="craft_end" />
  </bpmn:process>
</bpmn:definitions>`;

    async function processFlowElementIds(xml: string, processId: string): Promise<string[]> {
      const moddle = new BpmnModdle({});
      const { rootElement } = (await moddle.fromXML(xml)) as any;
      const process = rootElement.rootElements.find((el: any) => el.id === processId);
      return (process.flowElements ?? []).map((el: any) => el.id);
    }

    it("insertShape into a flow inside the linked process attaches -- and rewires -- entirely within it", async () => {
      // Exactly issue #94's repro: no explicit `process`, and the target
      // ("into") lives in the linked process, not the root one. Before the
      // fix, processFor(undefined) unconditionally returned mainProcess: the
      // new shape landed in "session" while the retargeted flow "cf1" (and
      // the new flow to craft_end) stayed wired to craft_graph's own
      // elements -- a bpmn:SequenceFlow split across two processes.
      const ops: GraphOp[] = [{ op: "insertShape", type: "bpmn:ServiceTask", id: "shell_echo", into: "cf1" }];
      const merged = await applyGraphOps(linkedBase, ops);

      const craftIds = await processFlowElementIds(merged, "craft_graph");
      const sessionIds = await processFlowElementIds(merged, "session");
      expect(craftIds).toContain("shell_echo");
      expect(sessionIds).not.toContain("shell_echo");

      // The document is well-formed (no cross-process flow), so checkSplice's
      // own process-scope guard can now actually see the added shape landed
      // in the linked process, and reject it with a redraftable reason.
      const splice = await checkSplice(linkedBase, merged);
      expect(splice.ok).toBe(false);
      expect(splice.reason).toMatch(/craft_graph/);
      expect(splice.reason).toMatch(/linked process/);
    });

    it("appendShape after a node inside the linked process attaches there too", async () => {
      const ops: GraphOp[] = [{ op: "appendShape", type: "bpmn:ServiceTask", id: "shell_echo", after: "craft_start" }];
      const merged = await applyGraphOps(linkedBase, ops);
      const craftIds = await processFlowElementIds(merged, "craft_graph");
      expect(craftIds).toContain("shell_echo");
    });

    it("connect between two nodes in the linked process attaches the new flow there too", async () => {
      const ops: GraphOp[] = [
        { op: "appendShape", type: "bpmn:ServiceTask", id: "a", after: "craft_start" },
        { op: "appendShape", type: "bpmn:ServiceTask", id: "b", after: "craft_start" },
        { op: "connect", from: "a", to: "b", id: "extra_flow" },
      ];
      const merged = await applyGraphOps(linkedBase, ops);
      const craftIds = await processFlowElementIds(merged, "craft_graph");
      expect(craftIds).toContain("extra_flow");
    });

    it("connect rejects wiring a node in the root process to one in the linked process", async () => {
      await expect(applyGraphOps(linkedBase, [{ op: "connect", from: "root_start", to: "craft_start" }])).rejects.toThrow(
        /cannot cross between processes/,
      );
    });

    it("an explicit process that disagrees with where the target lives is rejected, not silently honoured", async () => {
      await expect(
        applyGraphOps(linkedBase, [
          { op: "insertShape", type: "bpmn:ServiceTask", id: "shell_echo", into: "cf1", process: "session" },
        ]),
      ).rejects.toThrow(/does not match 'cf1'/);
    });
  });

  describe("attaches into a bpmn:SubProcess the target lives in, not the enclosing process (issue #100)", () => {
    // A single executable process with a subprocess nested inside it --
    // ownerProcessOf used to stop only at bpmn:Process, walking straight
    // past the subprocess boundary the same way #94 found it walk straight
    // past a linked process.
    const subProcessBase = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs_sub">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="sub" />
    <bpmn:subProcess id="sub"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:startEvent id="ss"><bpmn:outgoing>sf1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="sf1" sourceRef="ss" targetRef="st" />
      <bpmn:serviceTask id="st"><bpmn:incoming>sf1</bpmn:incoming><bpmn:outgoing>sf2</bpmn:outgoing></bpmn:serviceTask>
      <bpmn:sequenceFlow id="sf2" sourceRef="st" targetRef="se" />
      <bpmn:endEvent id="se"><bpmn:incoming>sf2</bpmn:incoming></bpmn:endEvent>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="sub" targetRef="e" />
    <bpmn:endEvent id="e"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

    async function elementParentId(xml: string, elementId: string): Promise<string | undefined> {
      const moddle = new BpmnModdle({});
      const { elementsById } = (await moddle.fromXML(xml)) as any;
      return elementsById[elementId]?.$parent?.id;
    }

    it("insertShape into a flow inside the subprocess attaches -- and rewires -- entirely within it", async () => {
      // Exactly issue #100's repro: no explicit `process`, and the target
      // ("into") lives inside the subprocess, not the enclosing process.
      const ops: GraphOp[] = [{ op: "insertShape", type: "bpmn:ServiceTask", id: "inner", into: "sf1" }];
      const merged = await applyGraphOps(subProcessBase, ops);

      expect(await elementParentId(merged, "inner")).toBe("sub");
      // The rewired original flow and the freshly connected one both stay
      // inside the subprocess too.
      expect(await elementParentId(merged, "sf1")).toBe("sub");

      // The document is well-formed, so checkSplice accepts it: "p" is the
      // one and only (executable) process either way, so this is a
      // perfectly legal splice, unlike #94's linked-process case.
      const splice = await checkSplice(subProcessBase, merged);
      expect(splice.ok).toBe(true);
      expect(splice.added).toContain("inner");
    });

    it("appendShape after a node inside the subprocess attaches there too", async () => {
      const ops: GraphOp[] = [{ op: "appendShape", type: "bpmn:ServiceTask", id: "inner", after: "ss" }];
      const merged = await applyGraphOps(subProcessBase, ops);
      expect(await elementParentId(merged, "inner")).toBe("sub");
    });

    it("connect between two nodes inside the subprocess attaches the new flow there too", async () => {
      const ops: GraphOp[] = [
        { op: "appendShape", type: "bpmn:ServiceTask", id: "a", after: "ss" },
        { op: "appendShape", type: "bpmn:ServiceTask", id: "b", after: "ss" },
        { op: "connect", from: "a", to: "b", id: "extra_flow" },
      ];
      const merged = await applyGraphOps(subProcessBase, ops);
      expect(await elementParentId(merged, "extra_flow")).toBe("sub");
    });

    it("connect rejects wiring a node outside the subprocess to one inside it", async () => {
      await expect(applyGraphOps(subProcessBase, [{ op: "connect", from: "s", to: "ss" }])).rejects.toThrow(
        /cannot cross between processes/,
      );
    });

    it("checkSplice/checkMigration reject a hand-written fragment with a cross-subprocess flow directly, independent of applyGraphOps", async () => {
      // The general containment invariant: checked from the document alone,
      // so a hand-written fragment or a studio edit is caught the same way
      // applyGraphOps's own output now is.
      const malformed = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs_sub">
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="s" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="sub" />
    <bpmn:subProcess id="sub">
      <bpmn:startEvent id="ss" />
      <bpmn:sequenceFlow id="sf1" sourceRef="ss" targetRef="st" />
      <bpmn:task id="st" />
      <bpmn:sequenceFlow id="sf2" sourceRef="st" targetRef="se" />
      <bpmn:endEvent id="se" />
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="sub" targetRef="e" />
    <bpmn:endEvent id="e" />
    <bpmn:task id="outer_task" />
    <bpmn:sequenceFlow id="bad_flow" sourceRef="ss" targetRef="outer_task" />
  </bpmn:process>
</bpmn:definitions>`;

      const splice = await checkSplice(subProcessBase, malformed);
      expect(splice.ok).toBe(false);
      expect(splice.reason).toMatch(/bad_flow/);
      expect(splice.reason).toMatch(/cannot cross between processes or subprocesses/);

      const migration = await checkMigration(subProcessBase, malformed, new Set());
      expect(migration.ok).toBe(false);
      expect(migration.reason).toMatch(/bad_flow/);
    });
  });

  it("throws a clear error for an unknown target id", async () => {
    await expect(applyGraphOps(base, [{ op: "appendShape", type: "bpmn:ServiceTask", id: "x", after: "nope" }])).rejects.toThrow(
      /unknown element id 'nope'/,
    );
  });

  it("throws a clear error for an unsupported type", async () => {
    await expect(
      applyGraphOps(base, [{ op: "appendShape", type: "bpmn:InclusiveGateway", id: "x", after: "gate" }]),
    ).rejects.toThrow(/not supported/);
  });

  it("throws a clear error when insertShape targets something other than a sequenceFlow", async () => {
    await expect(applyGraphOps(base, [{ op: "insertShape", type: "bpmn:ServiceTask", id: "x", into: "gate" }])).rejects.toThrow(
      /is not a sequenceFlow/,
    );
  });

  it("throws a clear error for a duplicate id", async () => {
    await expect(applyGraphOps(base, [{ op: "appendShape", type: "bpmn:ServiceTask", id: "gate", after: "start" }])).rejects.toThrow(
      /already exists/,
    );
  });

  it("throws a clear error for an id that is not a valid XML id, naming it, before it can hang a run (issue #109)", async () => {
    // Exactly issue #109's own repro: an id with a space passes checkSplice
    // (before the fix), serializes fine (well-formed XML tolerates far more
    // in an attribute value than an NCName allows), and then the token
    // parks on the node forever -- nothing ever sanitizes it enough to
    // dispatch a harness.
    await expect(
      applyGraphOps(base, [{ op: "appendShape", type: "bpmn:ServiceTask", id: "bad id", after: "gate" }]),
    ).rejects.toThrow(/'bad id' is not a valid XML id/);
  });

  it("rejects an invalid flowId the same way -- it names a real element in the document too", async () => {
    await expect(
      applyGraphOps(base, [{ op: "insertShape", type: "bpmn:ServiceTask", id: "mid", into: "f1", flowId: "bad flow" }]),
    ).rejects.toThrow(/'bad flow' is not a valid XML id/);
  });

  it("rejects an invalid createProcess id the same way", async () => {
    await expect(applyGraphOps(base, [{ op: "createProcess", id: "bad process" }])).rejects.toThrow(
      /'bad process' is not a valid XML id/,
    );
  });

  it("appendShape with eventDefinitionType adds a Terminate end event (closing the pre-existing gap)", async () => {
    const ops: GraphOp[] = [
      { op: "appendShape", type: "bpmn:EndEvent", id: "terminated", after: "gate", eventDefinitionType: "bpmn:TerminateEventDefinition" },
    ];
    const merged = await applyGraphOps(base, ops);
    expect(merged).toContain("<bpmn:terminateEventDefinition");
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toContain("terminated");
  });

  it("attachBoundaryEvent(timer) attaches a timeout to an existing activity, routed with a separate connect", async () => {
    const ops: GraphOp[] = [
      { op: "attachBoundaryEvent", id: "timeout1", attachedTo: "gate", eventDefinitionType: "bpmn:TimerEventDefinition", timerDuration: "PT30M" },
      { op: "appendShape", type: "bpmn:EndEvent", id: "timed_out", after: "timeout1" },
    ];
    const merged = await applyGraphOps(base, ops);
    expect(merged).toMatch(/<bpmn:boundaryEvent id="timeout1" attachedToRef="gate"/);
    expect(merged).toContain("<bpmn:timeDuration");
    expect(merged).toContain("PT30M");
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(expect.arrayContaining(["timeout1", "timed_out"]));
  });

  it("attachBoundaryEvent(conditional) attaches a cost limit condition to an activity", async () => {
    const ops: GraphOp[] = [
      {
        op: "attachBoundaryEvent",
        id: "cost_breached",
        attachedTo: "gate",
        eventDefinitionType: "bpmn:ConditionalEventDefinition",
        condition: "=_session.total_cost >= 0.50",
      },
      { op: "appendShape", type: "bpmn:EndEvent", id: "cost_stop", after: "cost_breached" },
    ];
    const merged = await applyGraphOps(base, ops);
    expect(merged).toMatch(/<bpmn:boundaryEvent id="cost_breached" attachedToRef="gate"/);
    expect(merged).toContain("<bpmn:conditionalEventDefinition");
    expect(merged).toContain("=_session.total_cost &gt;= 0.50");
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(expect.arrayContaining(["cost_breached", "cost_stop"]));
  });

  it("a conditional boundary event without condition is rejected", async () => {
    await expect(
      applyGraphOps(base, [
        {
          op: "attachBoundaryEvent",
          id: "c1",
          attachedTo: "gate",
          eventDefinitionType: "bpmn:ConditionalEventDefinition",
        },
      ]),
    ).rejects.toThrow(/needs a 'condition'/);
  });

  it("attachBoundaryEvent(error) defaults to interrupting (cancelActivity's own BPMN default, so moddle omits the attribute)", async () => {
    const ops: GraphOp[] = [
      { op: "attachBoundaryEvent", id: "err1", attachedTo: "gate", eventDefinitionType: "bpmn:ErrorEventDefinition" },
    ];
    const merged = await applyGraphOps(base, ops);
    expect(merged).toMatch(/<bpmn:boundaryEvent id="err1" attachedToRef="gate"/);
    expect(merged).not.toContain('cancelActivity="false"');
    expect(merged).toContain("<bpmn:errorEventDefinition");
  });

  it("attachBoundaryEvent honours cancelActivity: false (non-interrupting)", async () => {
    const ops: GraphOp[] = [
      { op: "attachBoundaryEvent", id: "err1", attachedTo: "gate", eventDefinitionType: "bpmn:ErrorEventDefinition", cancelActivity: false },
    ];
    const merged = await applyGraphOps(base, ops);
    expect(merged).toMatch(/cancelActivity="false"/);
  });

  it("attachBoundaryEvent throws a clear error against an unknown host id", async () => {
    await expect(
      applyGraphOps(base, [{ op: "attachBoundaryEvent", id: "t1", attachedTo: "nope", eventDefinitionType: "bpmn:TimerEventDefinition", timerDuration: "PT1H" }]),
    ).rejects.toThrow(/unknown element id 'nope'/);
  });

  it("a timer without timerDuration is rejected", async () => {
    await expect(
      applyGraphOps(base, [{ op: "appendShape", type: "bpmn:EndEvent", id: "e1", after: "gate", eventDefinitionType: "bpmn:TimerEventDefinition" }]),
    ).rejects.toThrow(/needs a 'timerDuration'/);
  });

  it("attachBoundaryEvent rejects an out-of-scope event definition (Terminate makes no sense on a boundary event)", async () => {
    await expect(
      applyGraphOps(base, [
        { op: "attachBoundaryEvent", id: "t1", attachedTo: "gate", eventDefinitionType: "bpmn:TerminateEventDefinition" as never },
      ]),
    ).rejects.toThrow(/not supported here/);
  });

  it("rejects a start/end event's out-of-scope event definition", async () => {
    await expect(
      applyGraphOps(base, [
        { op: "appendShape", type: "bpmn:EndEvent", id: "e1", after: "gate", eventDefinitionType: "bpmn:MessageEventDefinition" },
      ]),
    ).rejects.toThrow(/not supported/);
  });
});

describe("checkSplice/checkMigration reject a disallowed event definition", () => {
  const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;
  const allowedTypes = new Set(["bpmn:StartEvent", "bpmn:SequenceFlow", "bpmn:EndEvent"]);
  const allowedEventDefs = new Set(["bpmn:TerminateEventDefinition"]);

  function withEndEvent(eventDefTag: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f1</bpmn:incoming>${eventDefTag}</bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
  }

  it("accepts a new event whose event definition is allowed", async () => {
    const result = await checkSplice(
      base,
      withEndEvent("<bpmn:terminateEventDefinition />"),
      undefined,
      undefined,
      allowedTypes,
      allowedEventDefs,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a new event whose event definition is not allowed, naming the allowed set", async () => {
    const result = await checkSplice(
      base,
      withEndEvent("<bpmn:messageEventDefinition />"),
      undefined,
      undefined,
      allowedTypes,
      allowedEventDefs,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/bpmn:MessageEventDefinition/);
    expect(result.reason).toMatch(/bpmn:TerminateEventDefinition/);
  });

  it("does not check event definitions when no allowlist is given -- existing callers are unaffected", async () => {
    // errorEventDefinition, not messageEventDefinition: this only needs to be
    // outside allowedEventDefs, not outside SUPPORTED_EVENT_DEFINITIONS --
    // bpmnlint's own always-on runtime-support check (issue #104) would
    // reject an unsupported event definition regardless of this allowlist.
    const result = await checkSplice(base, withEndEvent("<bpmn:errorEventDefinition />"), undefined, undefined, allowedTypes);
    expect(result.ok).toBe(true);
  });

  it("checkMigration applies the same event-definition allowlist to a genuinely new element", async () => {
    const result = await checkMigration(
      base,
      withEndEvent("<bpmn:messageEventDefinition />"),
      new Set(),
      undefined,
      undefined,
      allowedTypes,
      allowedEventDefs,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/bpmn:MessageEventDefinition/);
  });
});

describe("checkSplice/checkMigration reject a splice into a linked process (issue #86)", () => {
  // Mirrors what linkGraph produces for a real session: a root (executable)
  // process plus a second, inlined process brought in via calledElement and
  // marked isExecutable="false" -- Definition.recover() cannot replay that
  // second process's child state once its own definition has changed
  // underneath it, so a splice landing there leaves the session permanently
  // stuck if the token ever reaches (or already occupies) it.
  const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="root_start" />
    <bpmn:sequenceFlow id="rf1" sourceRef="root_start" targetRef="call" />
    <bpmn:callActivity id="call" calledElement="craft_graph" />
    <bpmn:sequenceFlow id="rf2" sourceRef="call" targetRef="root_end" />
    <bpmn:endEvent id="root_end" />
  </bpmn:process>
  <bpmn:process id="craft_graph" isExecutable="false">
    <bpmn:startEvent id="craft_start" />
    <bpmn:sequenceFlow id="cf1" sourceRef="craft_start" targetRef="craft_end" />
    <bpmn:endEvent id="craft_end" />
  </bpmn:process>
</bpmn:definitions>`;

  // Same base graph, plus a task spliced between root_start and call --
  // additive: root_start's flow is re-pointed at it, and a new flow carries
  // on to call, exactly like v1 -> v2's own shape above.
  const splicedInRoot = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="root_start"><bpmn:outgoing>rf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="rf1" sourceRef="root_start" targetRef="new_task" />
    <bpmn:serviceTask id="new_task"><bpmn:incoming>rf1</bpmn:incoming><bpmn:outgoing>rf1b</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="rf1b" sourceRef="new_task" targetRef="call" />
    <bpmn:callActivity id="call" calledElement="craft_graph"><bpmn:incoming>rf1b</bpmn:incoming><bpmn:outgoing>rf2</bpmn:outgoing></bpmn:callActivity>
    <bpmn:sequenceFlow id="rf2" sourceRef="call" targetRef="root_end" />
    <bpmn:endEvent id="root_end"><bpmn:incoming>rf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmn:process id="craft_graph" isExecutable="false">
    <bpmn:startEvent id="craft_start"><bpmn:outgoing>cf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="cf1" sourceRef="craft_start" targetRef="craft_end" />
    <bpmn:endEvent id="craft_end"><bpmn:incoming>cf1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  // Same shape, but the new task lands in craft_graph (the linked process)
  // instead -- between craft_start and craft_end.
  const splicedInLinked = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="root_start" />
    <bpmn:sequenceFlow id="rf1" sourceRef="root_start" targetRef="call" />
    <bpmn:callActivity id="call" calledElement="craft_graph" />
    <bpmn:sequenceFlow id="rf2" sourceRef="call" targetRef="root_end" />
    <bpmn:endEvent id="root_end" />
  </bpmn:process>
  <bpmn:process id="craft_graph" isExecutable="false">
    <bpmn:startEvent id="craft_start" />
    <bpmn:sequenceFlow id="cf1" sourceRef="craft_start" targetRef="new_task" />
    <bpmn:task id="new_task" />
    <bpmn:sequenceFlow id="cf1b" sourceRef="new_task" targetRef="craft_end" />
    <bpmn:endEvent id="craft_end" />
  </bpmn:process>
</bpmn:definitions>`;

  it("accepts a new element spliced into the session's own (root, executable) process", async () => {
    const result = await checkSplice(base, splicedInRoot);
    expect(result.ok).toBe(true);
    expect(result.added).toContain("new_task");
  });

  it("rejects a new element spliced into a linked (isExecutable=false) process, naming it", async () => {
    const result = await checkSplice(base, splicedInLinked);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/new_task/);
    expect(result.reason).toMatch(/craft_graph/);
    expect(result.reason).toMatch(/linked process/);
  });

  it("checkMigration applies the same rejection to a human edit into the linked process", async () => {
    const result = await checkMigration(base, splicedInLinked, new Set());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/craft_graph/);
  });
});

describe("bpmn-elements really executes a parallel gateway and a timer boundary event (issue: parallel gateway and boundary event support)", () => {
  it("a parallel gateway forks into both branches and joins only once both have arrived", async () => {
    const parallelGraph = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_parallel" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <process id="parallel_proc" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="fork" />
    <parallelGateway id="fork" />
    <sequenceFlow id="f2" sourceRef="fork" targetRef="a" />
    <sequenceFlow id="f3" sourceRef="fork" targetRef="b" />
    <task id="a" />
    <task id="b" />
    <sequenceFlow id="f4" sourceRef="a" targetRef="join" />
    <sequenceFlow id="f5" sourceRef="b" targetRef="join" />
    <parallelGateway id="join" />
    <sequenceFlow id="f6" sourceRef="join" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

    const engine = new EngineCtor({ name: "parallel", source: parallelGraph });
    const executed: string[] = [];
    const listener = new EventEmitter();
    listener.on("activity.end", (api: { id: string }) => executed.push(api.id));
    const ended = engine.waitFor("end");
    await engine.execute({ listener });
    await ended;

    expect(executed).toEqual(expect.arrayContaining(["fork", "a", "b", "join", "end"]));
    // The join only ran once both branches had actually ended -- a real wait,
    // not bpmn-elements re-triggering it once per arriving token the way a
    // plain node with two incoming flows would (that's exactly the "fake
    // join" trap the linter forbids elsewhere).
    expect(executed.filter((id) => id === "join")).toHaveLength(1);
    const joinIndex = executed.indexOf("join");
    expect(executed.indexOf("a")).toBeLessThan(joinIndex);
    expect(executed.indexOf("b")).toBeLessThan(joinIndex);
  });

  it("a timer boundary event fires its own path and cancels the (interrupted) host activity", async () => {
    const NS = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"';
    const timerGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_timer" ${NS}>
  <bpmn:process id="timer_proc" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="wait_here" />
    <bpmn:userTask id="wait_here">
      <bpmn:incoming>f1</bpmn:incoming>
    </bpmn:userTask>
    <bpmn:boundaryEvent id="timeout" attachedToRef="wait_here">
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration>PT0.05S</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="timeout" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

    const engine = new EngineCtor({ name: "timer", source: timerGraph });
    const executed: string[] = [];
    const listener = new EventEmitter();
    listener.on("activity.end", (api: { id: string }) => executed.push(api.id));
    const ended = engine.waitFor("end");
    // Never signal "wait_here" -- the only way this run reaches "end" at all
    // is the timer firing on its own.
    await engine.execute({ listener });
    await ended;

    expect(executed).toContain("timeout");
    expect(executed).toContain("end");
    // Interrupting (cancelActivity's default): the host activity is
    // discarded when the timer fires, never reaching its own "activity.end".
    expect(executed).not.toContain("wait_here");
  }, 10000);
});

describe("firstActivity sees through a plain merge gateway (issue: forbid implicit merges)", () => {
  const DEFS =
    'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

  it("reports the real first stop, not the merge gateway placed in front of it", async () => {
    // The merging-exclusive-gateway pattern this project now requires instead
    // of an implicit multi-incoming merge (bpmnlint's fake-join, an error):
    // start and a loop-back both feed the gateway, which forwards
    // unconditionally to the human gate. A caller asking "does this graph's
    // first stop need an interactive answer" should see the gate, not the
    // gateway in front of it.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_1" ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start">
      <outgoing>f1</outgoing>
    </startEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="gw_entry" />
    <exclusiveGateway id="gw_entry">
      <incoming>f1</incoming>
      <incoming>loop_back</incoming>
      <outgoing>f2</outgoing>
    </exclusiveGateway>
    <sequenceFlow id="f2" sourceRef="gw_entry" targetRef="gate" />
    <userTask id="gate">
      <incoming>f2</incoming>
      <outgoing>f3</outgoing>
    </userTask>
    <sequenceFlow id="f3" sourceRef="gate" targetRef="end" />
    <sequenceFlow id="loop_back" sourceRef="gate" targetRef="gw_entry" />
    <endEvent id="end" />
  </process>
</definitions>`;

    expect(await firstActivity(xml)).toEqual({ id: "gate", type: "bpmn:UserTask" });
  });

  it("follows a chain of more than one merge gateway", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_1" ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start">
      <outgoing>f1</outgoing>
    </startEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="gw_a" />
    <exclusiveGateway id="gw_a">
      <incoming>f1</incoming>
      <outgoing>f2</outgoing>
    </exclusiveGateway>
    <sequenceFlow id="f2" sourceRef="gw_a" targetRef="gw_b" />
    <exclusiveGateway id="gw_b">
      <incoming>f2</incoming>
      <outgoing>f3</outgoing>
    </exclusiveGateway>
    <sequenceFlow id="f3" sourceRef="gw_b" targetRef="gate" />
    <userTask id="gate">
      <incoming>f3</incoming>
    </userTask>
  </process>
</definitions>`;

    expect(await firstActivity(xml)).toEqual({ id: "gate", type: "bpmn:UserTask" });
  });

  it("does not follow a genuine decision gateway (more than one outgoing)", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_1" ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start">
      <outgoing>f1</outgoing>
    </startEvent>
    <sequenceFlow id="f1" sourceRef="start" targetRef="gw_decide" />
    <exclusiveGateway id="gw_decide">
      <incoming>f1</incoming>
      <outgoing>f2</outgoing>
      <outgoing>f3</outgoing>
    </exclusiveGateway>
    <sequenceFlow id="f2" sourceRef="gw_decide" targetRef="a" />
    <sequenceFlow id="f3" sourceRef="gw_decide" targetRef="b" />
    <userTask id="a">
      <incoming>f2</incoming>
    </userTask>
    <userTask id="b">
      <incoming>f3</incoming>
    </userTask>
  </process>
</definitions>`;

    expect(await firstActivity(xml)).toEqual({ id: "gw_decide", type: "bpmn:ExclusiveGateway" });
  });
});

describe("checkSplice runs bpmnlint, catching a fake-join before approval (issue #104)", () => {
  // Exactly issue #104's own reproduction: workflows/shell-demo.bpmn lints
  // clean, but wiring "turn" straight into "end_verified" -- which already
  // has an incoming flow from the gateway -- makes it a plain node with two
  // incoming flows. bpmn-elements re-triggers that node once per arriving
  // token instead of joining (a real double-execution hazard, not a style
  // nit), and `make lint`/`promote` both already reject it; before this fix,
  // checkSplice was the one place in the round trip that didn't.
  const shellDemo = readFileSync(join(process.cwd(), "workflows", "shell-demo.bpmn"), "utf8");

  it("rejects a connect that turns an existing end event into a fake join", async () => {
    const ops: GraphOp[] = [{ op: "connect", from: "turn", to: "end_verified" }];
    const merged = await applyGraphOps(shellDemo, ops);
    const result = await checkSplice(shellDemo, merged);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fake-join/);
    expect(result.reason).toMatch(/end_verified/);
  });

  it("still accepts a genuine additive splice on the same graph", async () => {
    // insertShape, not appendShape: "turn" already has an outgoing flow, so
    // appending a second one from it would itself be an implicit split.
    const ops: GraphOp[] = [{ op: "insertShape", type: "bpmn:ServiceTask", id: "extra_step", into: "to_verify" }];
    const merged = await applyGraphOps(shellDemo, ops);
    const result = await checkSplice(shellDemo, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toContain("extra_step");
  });

  // local/label-layout reads <bpmndi:*> shapes -- exactly like no-bpmndi and
  // local/expanded-subprocesses, both already off in SEMANTIC_CONFIG for the
  // same reason -- but it only fires for a *named* gateway or event (a
  // task's label lives inside its own bounds, so it never trips), so the
  // failure was easy to miss (issue #106).
  it("accepts a splice adding a named gateway and a named end event, not just unnamed ones", async () => {
    const ops: GraphOp[] = [
      { op: "insertShape", type: "bpmn:ExclusiveGateway", id: "gw_new", into: "to_verify", name: "Which?" },
      { op: "appendShape", type: "bpmn:EndEvent", id: "end_new", after: "gw_new", name: "Bailed" },
    ];
    const merged = await applyGraphOps(shellDemo, ops);
    const result = await checkSplice(shellDemo, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(expect.arrayContaining(["gw_new", "end_new"]));
  });
});

describe("checkSplice accepts the fork/join and merge recipes AGENT_ROLES documents (issue #107)", () => {
  const shellDemo = readFileSync(join(process.cwd(), "workflows", "shell-demo.bpmn"), "utf8");

  it("builds a genuine parallel fork/join with two real branches, exactly what the drafting prompt asks for", async () => {
    // insertShape the fork into the existing flow, naming its own
    // auto-continuation (flowId) so it can be insertShape'd into again for
    // branch one's own real step -- then the join, then appendShape/connect
    // branch two. No id-guessing (issue #107): every id either comes from
    // the op that creates it or is named explicitly via flowId.
    const ops: GraphOp[] = [
      { op: "insertShape", type: "bpmn:ParallelGateway", id: "fk", into: "to_verify", flowId: "fk_out" },
      { op: "insertShape", type: "bpmn:ServiceTask", id: "echo_one", into: "fk_out", flowId: "to_join" },
      { op: "insertShape", type: "bpmn:ParallelGateway", id: "jn", into: "to_join" },
      { op: "appendShape", type: "bpmn:ServiceTask", id: "echo_two", after: "fk" },
      { op: "connect", from: "echo_two", to: "jn" },
    ];
    const merged = await applyGraphOps(shellDemo, ops);
    const result = await checkSplice(shellDemo, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(expect.arrayContaining(["fk", "echo_one", "jn", "echo_two"]));
  });

  it("merges a fresh entry into an existing flow through an exclusive gateway, without a fake join", async () => {
    // "A loop-back alongside a fresh entry" (AGENT_ROLES): an error-boundary
    // retry path (the fresh entry -- a boundary event has no outgoing of its
    // own to begin with, so wiring one is never an implicit split) needs to
    // reconverge with the host activity's own normal continuation before a
    // shared target. insertShape the merge gateway into that pre-existing
    // flow (the only side that needs retargeting), then connect the fresh
    // entry straight into it.
    const NS = 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
    const base = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="Defs_merge_test">
  <bpmn:process id="merge_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:serviceTask id="gate"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    const ops: GraphOp[] = [
      { op: "attachBoundaryEvent", id: "err_boundary", attachedTo: "gate", eventDefinitionType: "bpmn:ErrorEventDefinition" },
      { op: "appendShape", type: "bpmn:ServiceTask", id: "handle_error", after: "err_boundary" },
      { op: "insertShape", type: "bpmn:ExclusiveGateway", id: "gw_merge", into: "f2" },
      { op: "connect", from: "handle_error", to: "gw_merge" },
    ];
    const merged = await applyGraphOps(base, ops);
    const result = await checkSplice(base, merged);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(expect.arrayContaining(["err_boundary", "handle_error", "gw_merge"]));
  });
});
