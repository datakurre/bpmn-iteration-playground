import { describe, expect, it } from "vitest";
import {
  activityProperties,
  feelBody,
  formDefinition,
  harnessOf,
  ioMapping,
  resolveInput,
  resolveOutput,
  retriesOf,
  type ActivityLike,
} from "./zeebe.ts";
import { evaluateFeel } from "./expressions.ts";

/** The engine passes FEEL sources through the same evaluator the runner uses. */
const feel = (expression: string, scope: Record<string, unknown>): unknown =>
  evaluateFeel(expression, { environment: { variables: scope, output: {} }, content: {} });

function activity(values: Array<Record<string, unknown>>): ActivityLike {
  return { id: "task", type: "bpmn:ServiceTask", behaviour: { extensionElements: { values } } };
}

describe("harnessOf", () => {
  it("reads the job type from zeebe:taskDefinition", () => {
    expect(harnessOf(activity([{ $type: "zeebe:TaskDefinition", type: "agent:turn" }]))).toBe("agent:turn");
  });
  it("is undefined when the activity defines no job", () => {
    expect(harnessOf(activity([]))).toBeUndefined();
  });
});

describe("retriesOf", () => {
  it("reads retries when declared", () => {
    expect(retriesOf(activity([{ $type: "zeebe:TaskDefinition", type: "t", retries: "3" }]))).toBe(3);
  });
  it("is undefined when absent or unparseable", () => {
    expect(retriesOf(activity([{ $type: "zeebe:TaskDefinition", type: "t" }]))).toBeUndefined();
    expect(retriesOf(activity([{ $type: "zeebe:TaskDefinition", type: "t", retries: "=x" }]))).toBeUndefined();
  });
});

describe("activityProperties", () => {
  it("reads zeebe:taskHeaders, C8's idiomatic place for static config", () => {
    const a = activity([{ $type: "zeebe:TaskHeaders", values: [{ key: "agent_role", value: "planner" }] }]);
    expect(activityProperties(a)).toEqual({ agent_role: "planner" });
  });

  it("also reads zeebe:properties", () => {
    const a = activity([{ $type: "zeebe:Properties", values: [{ name: "note", value: "hi" }] }]);
    expect(activityProperties(a)).toEqual({ note: "hi" });
  });

  it("lets a header win over a property of the same name", () => {
    const a = activity([
      { $type: "zeebe:Properties", values: [{ name: "agent_role", value: "from-property" }] },
      { $type: "zeebe:TaskHeaders", values: [{ key: "agent_role", value: "from-header" }] },
    ]);
    expect(activityProperties(a).agent_role).toBe("from-header");
  });
});

describe("feelBody", () => {
  it("strips Camunda 8's leading =", () => {
    expect(feelBody('=status = "success"')).toBe('status = "success"');
  });
  it("leaves a bare expression alone", () => {
    expect(feelBody("status")).toBe("status");
  });
});

describe("ioMapping", () => {
  it("separates inputs from outputs", () => {
    const a = activity([
      {
        $type: "zeebe:IoMapping",
        inputParameters: [{ source: "=goal", target: "instructions" }],
        outputParameters: [{ source: "=status", target: "agent_status" }],
      },
    ]);
    expect(ioMapping(a)).toEqual({
      input: [{ source: "=goal", target: "instructions" }],
      output: [{ source: "=status", target: "agent_status" }],
    });
  });
});

describe("resolveInput", () => {
  it("evaluates each source and binds it to its target", () => {
    // Note the direction: source is the expression, target the variable name --
    // the reverse of Camunda 7's inputParameter.
    const a = activity([
      {
        $type: "zeebe:IoMapping",
        inputParameters: [
          { source: "=goal", target: "instructions" },
          { source: '=if retries > 0 then "retry" else "first"', target: "attempt" },
        ],
        outputParameters: [],
      },
    ]);
    expect(resolveInput(a, { goal: "add tests", retries: 1 }, feel)).toEqual({
      instructions: "add tests",
      attempt: "retry",
    });
  });

  it("reads JSON-native structures without a dotted-path helper", () => {
    const a = activity([
      {
        $type: "zeebe:IoMapping",
        inputParameters: [{ source: "=review.findings[1]", target: "second" }],
        outputParameters: [],
      },
    ]);
    // FEEL list indices are 1-based.
    expect(resolveInput(a, { review: { findings: ["a", "b"] } }, feel)).toEqual({ second: "a" });
  });
});

describe("resolveOutput", () => {
  it("evaluates sources against the job result", () => {
    const a = activity([
      {
        $type: "zeebe:IoMapping",
        inputParameters: [],
        outputParameters: [
          { source: "=status", target: "agent_status" },
          { source: "=count(findings)", target: "finding_count" },
        ],
      },
    ]);
    expect(resolveOutput(a, { status: "success", findings: ["x", "y"] }, feel)).toEqual({
      agent_status: "success",
      finding_count: 2,
    });
  });
});

describe("formDefinition", () => {
  it("reads a user task's form reference", () => {
    const a = activity([{ $type: "zeebe:FormDefinition", formId: "approval-form" }]);
    expect(formDefinition(a)).toEqual({ formId: "approval-form" });
  });
  it("is undefined when the task has no form", () => {
    expect(formDefinition(activity([]))).toBeUndefined();
  });
});
