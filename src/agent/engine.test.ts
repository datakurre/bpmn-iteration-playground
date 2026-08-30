// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runGraph, resumeGraph, type ActivityOutcome } from "./engine.ts";
import { ok, type Harness, type HarnessContext } from "./harness.ts";

const DEFS = 'id="Defs_t" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

/** start -> turn (harness) -> XOR on the harness's status -> done | failed */
const routed = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="turn" />
    <serviceTask id="turn" name="Agent turn">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:taskHeaders>
          <zeebe:header key="role" value="planner" />
        </zeebe:taskHeaders>
        <zeebe:ioMapping>
          <zeebe:input source="=goal" target="instructions" />
          <zeebe:output source="=status" target="agent_status" />
        </zeebe:ioMapping>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="turn" targetRef="gw" />
    <exclusiveGateway id="gw" />
    <sequenceFlow id="f3" sourceRef="gw" targetRef="done">
      <conditionExpression xsi:type="tFormalExpression">=agent_status = "success"</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f4" sourceRef="gw" targetRef="failed">
      <conditionExpression xsi:type="tFormalExpression">=agent_status != "success"</conditionExpression>
    </sequenceFlow>
    <endEvent id="done" />
    <endEvent id="failed" />
  </process>
</definitions>`;

describe("runGraph", () => {
  it("dispatches an activity to the harness named by zeebe:taskDefinition", async () => {
    const seen: HarnessContext[] = [];
    const harness: Harness = async (context) => {
      seen.push(context);
      return ok("planned");
    };

    const result = await runGraph(routed, {
      harnesses: { "agent:turn": harness },
      variables: { goal: "add a health check" },
    });

    expect(result.outcome).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.harness).toBe("agent:turn");
    expect(seen[0]?.activityId).toBe("turn");
    expect(seen[0]?.activityName).toBe("Agent turn");
    // the job type lives in zeebe:taskDefinition, so headers carry only real metadata
    expect(seen[0]?.properties).toEqual({ role: "planner" });
    // zeebe:input resolved against process variables
    expect(seen[0]?.input).toEqual({ instructions: "add a health check" });
  });

  it("publishes zeebe:output so the next gateway can route on it", async () => {
    const result = await runGraph(routed, {
      harnesses: { "agent:turn": async () => ok("planned") },
      variables: { goal: "g" },
    });
    expect(result.variables.agent_status).toBe("success");
    expect(result.activities.map((a: ActivityOutcome) => a.activityId)).toEqual(["turn"]);
  });

  it("routes down the failure branch when the harness fails", async () => {
    const result = await runGraph(routed, {
      harnesses: {
        "agent:turn": async () => ({
          status: "failed" as const,
          summary: "nope",
          findings: [],
          artifacts: [],
          next_action: "stop" as const,
        }),
      },
      variables: { goal: "g" },
    });
    expect(result.outcome).toBe("completed");
    expect(result.variables.agent_status).toBe("failed");
  });

  it("errors when the graph names a harness nothing implements", async () => {
    const result = await runGraph(routed, { harnesses: {}, variables: { goal: "g" } });
    expect(result.outcome).toBe("error");
    expect(result.error?.message).toMatch(/no harness registered for 'agent:turn'/);
  });

  it("reports the ids the token rests on as it moves", async () => {
    const tokenReports: string[][] = [];
    await runGraph(routed, {
      harnesses: { "agent:turn": async () => ok("planned") },
      variables: { goal: "g" },
      onTokens: (tokens) => {
        tokenReports.push(tokens);
      },
    });
    expect(tokenReports.length).toBeGreaterThan(0);
  });
});

const retried = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="turn" />
    <serviceTask id="turn" name="Flaky step">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" retries="3" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="turn" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

describe("zeebe:taskDefinition retries", () => {
  it("retries a harness that throws, up to the configured count", async () => {
    let calls = 0;
    const result = await runGraph(retried, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          if (calls < 3) throw new Error(`flaky, attempt ${calls}`);
          return ok("finally");
        },
      },
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toBe(3);
  });

  it("gives up once the configured retries are exhausted", async () => {
    let calls = 0;
    const result = await runGraph(retried, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          throw new Error(`always flaky, attempt ${calls}`);
        },
      },
    });
    expect(result.outcome).toBe("error");
    expect(calls).toBe(3);
    expect(result.error?.message).toMatch(/always flaky, attempt 3/);
  });

  it("does not retry when no retries are configured", async () => {
    let calls = 0;
    const result = await runGraph(routed, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          throw new Error("boom");
        },
      },
      variables: { goal: "g" },
    });
    expect(result.outcome).toBe("error");
    expect(calls).toBe(1);
  });

  it("never retries a harness that returns status: 'failed' rather than throwing", async () => {
    // A `failed(...)` result is a business error the graph routes on with a
    // gateway, not a job failure -- retrying it would just run it again
    // unconditionally, which is not what C8's retries model.
    let calls = 0;
    const result = await runGraph(retried, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          return { status: "failed" as const, summary: "business error", findings: [], artifacts: [], next_action: "stop" as const };
        },
      },
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toBe(1);
  });
});

/** A user task the process parks on, so a run can be snapshotted mid-flight. */
const parking = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" />
    <sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

/** the same graph, with a harness-backed task spliced in after the gate */
const parkingExtended = parking
  .replace('<sequenceFlow id="f2" sourceRef="gate" targetRef="end" />', '<sequenceFlow id="f2" sourceRef="gate" targetRef="added" />')
  .replace('<endEvent id="end" />', `<serviceTask id="added">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f3" sourceRef="added" targetRef="end" />
    <endEvent id="end" />`);

describe("runGraph parking", () => {
  it("reports the token on the very first activity, not just later ones", async () => {
    // engine.execution -- what postponedIds() normally reads -- is not assigned
    // yet the first time a fresh run parks on its own first activity, so this
    // has to come from the wait event itself rather than the postponed set.
    const tokenReports: string[][] = [];
    const result = await runGraph(parking, {
      harnesses: {},
      onTokens: (tokens) => {
        tokenReports.push(tokens);
      },
    });

    expect(result.outcome).toBe("stopped");
    expect(tokenReports.at(-1)).toEqual(["gate"]);
  });
});

describe("resumeGraph", () => {
  it("continues a parked run into a node the graph gained while it waited", async () => {
    const first = await runGraph(parking, { harnesses: {} });
    // the run is parked on the user task, not finished
    expect(first.outcome).toBe("stopped");

    const ran: string[] = [];
    const second = await resumeGraph(first.state, parkingExtended, {
      // answering the gate is what releases the token into the new node
      onWait: () => ({ approved: true }),
      harnesses: {
        "agent:turn": async (context) => {
          ran.push(context.activityId);
          return ok("ran the spliced node");
        },
      },
    });

    expect(ran).toEqual(["added"]);
    expect(second.activities.map((a) => a.activityId)).toEqual(["added"]);
    expect(second.outcome).toBe("completed");
  });

  it("answers a parked gate into a callActivity's process, reached for the first time (issue #30)", async () => {
    // Answering synchronously, in the same tick a resumed run reaches a
    // callActivity it has never entered before, used to throw "cannot resume
    // running process <callee>": bpmn-elements' own message-redelivery
    // handling races with instantiating that brand-new child process during a
    // resume cycle. session-skeleton.bpmn hits this on every self-extending
    // session, since `craft`'s first callActivity sits right behind the very
    // gate `resume --answer` exists to answer.
    const parkingWithCall = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" />
    <sequenceFlow id="f2" sourceRef="gate" targetRef="call" />
    <callActivity id="call" calledElement="callee" />
    <sequenceFlow id="f3" sourceRef="call" targetRef="end" />
    <endEvent id="end" />
  </process>
  <process id="callee" isExecutable="false">
    <startEvent id="c_start" />
    <sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_turn" />
    <serviceTask id="c_turn">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="cf2" sourceRef="c_turn" targetRef="c_end" />
    <endEvent id="c_end" />
  </process>
</definitions>`;

    const first = await runGraph(parkingWithCall, { harnesses: {} });
    expect(first.outcome).toBe("stopped");

    const ran: string[] = [];
    const second = await resumeGraph(first.state, parkingWithCall, {
      // A plain, synchronous answer -- exactly what `resume --answer` gives.
      onWait: () => ({ approved: true }),
      harnesses: {
        "agent:turn": async (context) => {
          ran.push(context.activityId);
          return ok("ran the callee");
        },
      },
    });

    expect(second.error).toBeUndefined();
    expect(ran).toEqual(["c_turn"]);
    expect(second.outcome).toBe("completed");
  });

  it("the hang guard still settles a resume against a snapshot with nothing left to dispatch (issue #52/#63)", async () => {
    // `runner.ts`'s resumeSession now refuses this case outright once a
    // session's own status is "completed" (issue #63), but the underlying
    // mechanism this proves -- engine.resume() dispatching nothing at all,
    // with none of drive()'s raced promises ever settling on their own --
    // is a property of resumeGraph itself, reachable by anything that hands
    // it a snapshot with no token left, regardless of what a caller's own
    // bookkeeping says. This is that guard, exercised directly.
    const trivial = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

    const first = await runGraph(trivial, { harnesses: {} });
    expect(first.outcome).toBe("completed");

    const second = await resumeGraph(first.state, trivial, { harnesses: {}, hangGuardMs: 50 });

    expect(second.outcome).toBe("stopped");
    expect(second.note).toMatch(/dispatched nothing/);
  });
});

describe("a callActivity's own zeebe:output (issue #66)", () => {
  it("reads the called process's published variable by its bare name, for a gateway back in the caller", async () => {
    // Unlike a harness-backed activity's zeebe:ioMapping (bridged session-wide
    // via sharedOutput) or a user task's answered form (applied directly from
    // its flat signaled output), a callActivity's own signaled output arrives
    // wrapped one layer deeper -- bpmn-elements relays it through the same
    // delegate-signal machinery a message end event uses, as
    // `{ executionId, output: {...theCalledProcess'sOwnEnvironmentOutput} }`.
    // Unwrapped, "=status" would read undefined (there is no bare `status` at
    // that depth) and "=output.status" would *also* fail, since `output` is
    // itself a reserved root in feelContext pointing at this activity's own
    // (empty) environment.output, not at the nested payload. This is the
    // general mechanism `session-craft.bpmn`'s `gw_crafted` needs to route on
    // `extend_status`, set by `apply_extension` deep inside `craft_graph`.
    const callerReadsCallee = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="call" />
    <callActivity id="call" calledElement="callee">
      <extensionElements>
        <zeebe:ioMapping>
          <zeebe:output source="=status" target="result" />
        </zeebe:ioMapping>
      </extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="call" targetRef="gw" />
    <exclusiveGateway id="gw" default="no" />
    <sequenceFlow id="yes" sourceRef="gw" targetRef="end_yes">
      <conditionExpression xsi:type="tFormalExpression">=result = "success"</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="no" sourceRef="gw" targetRef="end_no" />
    <endEvent id="end_yes" />
    <endEvent id="end_no" />
  </process>
  <process id="callee" isExecutable="false">
    <startEvent id="c_start" />
    <sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_turn" />
    <serviceTask id="c_turn">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:output source="=status" target="status" />
        </zeebe:ioMapping>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="cf2" sourceRef="c_turn" targetRef="c_end" />
    <endEvent id="c_end" />
  </process>
</definitions>`;

    const warnings: string[] = [];
    const visited = new Set<string>();
    const result = await runGraph(callerReadsCallee, {
      harnesses: { "agent:turn": async () => ok("did the thing", { status: "success" }) },
      onExpressionWarning: (w) => warnings.push(w.message),
      onTokens: (_tokens, v) => v.forEach((id) => visited.add(id)),
    });

    expect(result.outcome).toBe("completed");
    expect(warnings).toEqual([]);
    expect(result.variables.result).toBe("success");
    expect(visited.has("end_yes")).toBe(true);
    expect(visited.has("c_turn")).toBe(true);
  });
});
