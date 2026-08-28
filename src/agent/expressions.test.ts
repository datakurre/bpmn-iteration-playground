// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { camundaExpressions, evaluateFeel, feelContext, isEngineExpression } from "./expressions.ts";

const handler = camundaExpressions();
const scope = (variables: Record<string, unknown>) => ({ environment: { variables, output: {} }, content: {} });

function evaluate(expression: string, variables: Record<string, unknown>): unknown {
  return handler.resolveExpression(expression, scope(variables));
}

describe("isEngineExpression", () => {
  it("keeps bpmn-elements' own roots away from FEEL", () => {
    expect(isEngineExpression("environment.services.turn")).toBe(true);
    expect(isEngineExpression("content.id")).toBe(true);
  });
  it("treats a plain variable reference as FEEL", () => {
    expect(isEngineExpression('status = "success"')).toBe(false);
    expect(isEngineExpression("goal")).toBe(false);
  });
});

describe("feelContext", () => {
  it("exposes process variables as bare names and under `variables`", () => {
    const context = feelContext(scope({ goal: "ship" }));
    expect(context.goal).toBe("ship");
    expect(context.variables).toEqual({ goal: "ship" });
  });
});

describe("camundaExpressions", () => {
  it("resolves a bare variable reference", () => {
    expect(evaluate("${goal}", { goal: "ship it" })).toBe("ship it");
  });

  it("still routes engine-internal references to the default handler", () => {
    expect(evaluate("${environment.variables.count}", { count: 7 })).toBe(7);
  });

  it("evaluates FEEL comparisons on gateway conditions", () => {
    expect(evaluate('${status = "success"}', { status: "success" })).toBe(true);
    expect(evaluate('${status = "success"}', { status: "failed" })).toBe(false);
    expect(evaluate('${status != "success"}', { status: "failed" })).toBe(true);
  });

  it("handles boolean combinations, ranges and if/then/else", () => {
    expect(evaluate('${status = "success" and retries < 3}', { status: "success", retries: 1 })).toBe(true);
    expect(evaluate('${status = "success" and retries < 3}', { status: "success", retries: 5 })).toBe(false);
    expect(evaluate("${retries in [1..3]}", { retries: 2 })).toBe(true);
    expect(evaluate('${if turns > 5 then "long" else "short"}', { turns: 9 })).toBe("long");
  });

  it("is total: an unknown name yields false rather than throwing", () => {
    expect(evaluate('${missing = "x"}', {})).toBe(false);
  });

  it("reports unknown variables as warnings, since that is usually a modelling bug", () => {
    const onWarning = vi.fn();
    const warned = camundaExpressions({ onWarning });
    warned.resolveExpression('${missing = "x"}', scope({}));
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/missing/) }));
  });

  it("interpolates mixed literal text through the default handler", () => {
    expect(evaluate("run ${environment.variables.id}", { id: "abc" })).toBe("run abc");
  });

  it("shadows the Object.prototype names a diagram could otherwise reach", () => {
    // feelin resolves names against a scope of its own, so a null-prototype
    // context is not enough: without the explicit shadows, `constructor`
    // evaluates to the Object constructor and `constructor.constructor` to
    // `Function`. Both must come back null.
    for (const probe of ["constructor", "constructor.constructor", "__proto__", "toString"]) {
      expect(evaluateFeel(probe, scope({}))).toBeNull();
    }
  });

  it("still lets ordinary variables through after shadowing", () => {
    expect(evaluateFeel("goal", scope({ goal: "ship" }))).toBe("ship");
  });
});
