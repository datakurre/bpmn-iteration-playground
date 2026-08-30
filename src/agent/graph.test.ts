// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Engine } from "bpmn-engine";
import { EventEmitter } from "node:events";
import {
  checkMigration,
  checkSplice,
  definitionsId,
  elementIds,
  recoverWithGraph,
  stripEmbeddedSource,
  toSourceContext,
  withDefinitionsId,
  type EngineConstructor,
  type EngineState,
} from "./graph.ts";

const EngineCtor = Engine as unknown as EngineConstructor;

/** v1: start -> gate (user task) -> end */
const v1 = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_session" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <process id="session" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" name="await turn" />
    <sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

/** v2: the same graph with a service task spliced between gate and end. */
const v2 = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_session" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn">
  <process id="session" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" name="await turn" />
    <sequenceFlow id="f2" sourceRef="gate" targetRef="spliced" />
    <serviceTask id="spliced" name="agent turn" implementation="\${environment.services.turn}">
      <extensionElements>
        <camunda:properties><camunda:property name="harness" value="agent:turn" /></camunda:properties>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f3" sourceRef="spliced" targetRef="end" />
    <endEvent id="end" />
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
    const withoutGate = v1.replace('<userTask id="gate" name="await turn" />', "");
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
    <bpmn:startEvent id="start" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="run_it" />
    <bpmn:serviceTask id="run_it">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="${jobType}" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="run_it" targetRef="end" />
    <bpmn:endEvent id="end" />
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

describe("checkMigration (issue #46)", () => {
  it("accepts deleting an element the token has never reached, unlike checkSplice", async () => {
    const withoutGate = v1.replace('<userTask id="gate" name="await turn" />', "");
    // checkSplice rejects this outright -- gate is a real removal.
    expect((await checkSplice(v1, withoutGate)).ok).toBe(false);
    // checkMigration allows it as long as "gate" never carried live state.
    const result = await checkMigration(v1, withoutGate, new Set());
    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
  });

  it("rejects deleting an element that does carry live state", async () => {
    const withoutGate = v1.replace('<userTask id="gate" name="await turn" />', "");
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
