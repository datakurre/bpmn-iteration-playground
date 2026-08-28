// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Engine } from "bpmn-engine";
import { EventEmitter } from "node:events";
import {
  checkSplice,
  elementIds,
  recoverWithGraph,
  stripEmbeddedSource,
  toSourceContext,
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
