// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runGraph, resumeGraph, type ActivityOutcome } from "./engine.ts";
import { ok, type Harness, type HarnessContext } from "./harness.ts";

const DEFS = 'id="Defs_t" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn"';

/** start -> turn (harness) -> XOR on the harness's status -> done | failed */
const routed = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="turn" />
    <serviceTask id="turn" name="Agent turn">
      <extensionElements>
        <camunda:properties>
          <camunda:property name="harness" value="agent:turn" />
          <camunda:property name="role" value="planner" />
        </camunda:properties>
        <camunda:inputOutput>
          <camunda:inputParameter name="instructions">\${goal}</camunda:inputParameter>
          <camunda:outputParameter name="agent_status">\${status}</camunda:outputParameter>
        </camunda:inputOutput>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="turn" targetRef="gw" />
    <exclusiveGateway id="gw" />
    <sequenceFlow id="f3" sourceRef="gw" targetRef="done">
      <conditionExpression xsi:type="tFormalExpression">\${agent_status = "success"}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f4" sourceRef="gw" targetRef="failed">
      <conditionExpression xsi:type="tFormalExpression">\${agent_status != "success"}</conditionExpression>
    </sequenceFlow>
    <endEvent id="done" />
    <endEvent id="failed" />
  </process>
</definitions>`;

describe("runGraph", () => {
  it("dispatches an activity to the harness named in camunda:properties", async () => {
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
    // the harness selector itself is not leaked as ordinary metadata
    expect(seen[0]?.properties).toEqual({ role: "planner" });
    // camunda:inputParameter resolved against process variables
    expect(seen[0]?.input).toEqual({ instructions: "add a health check" });
  });

  it("publishes camunda:outputParameter so the next gateway can route on it", async () => {
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
        <camunda:properties><camunda:property name="harness" value="agent:turn" /></camunda:properties>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f3" sourceRef="added" targetRef="end" />
    <endEvent id="end" />`);

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
});
