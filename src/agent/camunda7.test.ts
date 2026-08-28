import { describe, expect, it } from "vitest";
import {
  camundaFormFields,
  camundaProperties,
  harnessOf,
  lookup,
  resolveExpression,
  resolveInput,
  resolveOutput,
  type ActivityLike,
} from "./camunda7.ts";

function activity(values: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): ActivityLike {
  return { id: "task", type: "bpmn:ServiceTask", behaviour: { extensionElements: { values }, ...extra } };
}

describe("camundaProperties", () => {
  it("flattens camunda:Properties", () => {
    const a = activity([
      { $type: "camunda:Properties", values: [{ name: "harness", value: "agent:turn" }, { name: "role", value: "planner" }] },
    ]);
    expect(camundaProperties(a)).toEqual({ harness: "agent:turn", role: "planner" });
  });

  it("accepts the archived diagrams' harness_type spelling", () => {
    const a = activity([{ $type: "camunda:Properties", values: [{ name: "harness_type", value: "pi_agent" }] }]);
    expect(harnessOf(a)).toBe("pi_agent");
  });

  it("prefers harness over harness_type when both are present", () => {
    const a = activity([
      { $type: "camunda:Properties", values: [{ name: "harness_type", value: "pi_agent" }, { name: "harness", value: "agent:turn" }] },
    ]);
    expect(harnessOf(a)).toBe("agent:turn");
  });

  it("returns undefined when no harness is declared", () => {
    expect(harnessOf(activity([]))).toBeUndefined();
  });
});

describe("lookup", () => {
  it("follows dotted paths", () => {
    expect(lookup({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });
  it("indexes arrays by numeric segment", () => {
    expect(lookup({ findings: ["first", "second"] }, "findings.1")).toBe("second");
  });
  it("returns undefined rather than throwing on a missing branch", () => {
    expect(lookup({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(lookup({}, "nope")).toBeUndefined();
  });
});

describe("resolveExpression", () => {
  it("preserves type for a whole-string expression", () => {
    expect(resolveExpression("${count}", { count: 3 })).toBe(3);
    expect(resolveExpression("${obj}", { obj: { a: 1 } })).toEqual({ a: 1 });
  });
  it("interpolates when mixed with literal text", () => {
    expect(resolveExpression("goal: ${goal}!", { goal: "ship" })).toBe("goal: ship!");
  });
  it("renders a missing value as empty rather than 'undefined'", () => {
    expect(resolveExpression("x=${nope}", {})).toBe("x=");
  });
  it("does not evaluate code", () => {
    // The expression grammar is lookup-only; anything else is just a missing path.
    expect(resolveExpression("${1+1}", {})).toBeUndefined();
  });
});

describe("resolveInput", () => {
  it("maps camunda:inputParameter onto a harness payload", () => {
    const a = activity([
      {
        $type: "camunda:InputOutput",
        inputParameters: [
          { name: "instructions", value: "${goal}" },
          { name: "context", value: "${extra.note}" },
        ],
        outputParameters: [],
      },
    ]);
    expect(resolveInput(a, { goal: "add tests", extra: { note: "be brief" } })).toEqual({
      instructions: "add tests",
      context: "be brief",
    });
  });
});

describe("resolveOutput", () => {
  it("publishes named output parameters from the harness result", () => {
    const a = activity([
      {
        $type: "camunda:InputOutput",
        inputParameters: [],
        outputParameters: [
          { name: "agent_status", source: "${status}" },
          { name: "first_finding", source: "${findings.0}" },
        ],
      },
    ]);
    expect(resolveOutput(a, { status: "success", findings: ["needs a test"] })).toEqual({
      agent_status: "success",
      first_finding: "needs a test",
    });
  });

  it("publishes the whole result under camunda:resultVariable", () => {
    const a = activity([], { resultVariable: "turn" });
    expect(resolveOutput(a, { status: "success" })).toEqual({ turn: { status: "success" } });
  });
});

describe("camundaFormFields", () => {
  it("reads user task form fields", () => {
    const a = activity([
      { $type: "camunda:FormData", fields: [{ id: "approval", label: "Approve?", type: "boolean" }] },
    ]);
    expect(camundaFormFields(a)).toEqual([{ id: "approval", label: "Approve?", type: "boolean" }]);
  });
});
