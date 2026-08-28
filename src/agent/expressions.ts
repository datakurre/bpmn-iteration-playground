/**
 * FEEL expression handling for the engine.
 *
 * bpmn-elements' default handler resolves `${a.b.c}` to a value and nothing
 * more: a sequence-flow condition can only be a truthy test, so a diagram cannot
 * say "take this branch when the turn succeeded" without dropping into a
 * `language="javascript"` script.
 *
 * Graphs here are Camunda 8 flavoured, so expressions are FEEL and are written
 * the way Camunda 8 writes them -- a leading `=`, no `${}` wrapper:
 *
 *     <conditionExpression>=status = "success"</conditionExpression>
 *     <conditionExpression>=status = "success" and retries &lt; 3</conditionExpression>
 *
 * `${...}` is still recognised, because bpmn-elements uses that form internally
 * for its own references (`${environment.services.x}`), and because a diagram
 * carried over from Camunda 7 should not silently evaluate to a literal string.
 *
 * FEEL is a total expression language with no function definition and no
 * assignment. It does, however, *invoke* functions it finds in its context, and
 * name resolution reaches inherited properties -- `constructor.constructor`
 * evaluates to `Function` even when the context is built with a null prototype.
 * `feelContext` therefore shadows the Object.prototype names explicitly; see
 * SAFE_SHADOWS.
 *
 * Note for anyone porting the archived Python diagrams: FEEL uses `=` for
 * equality and double-quoted strings, so `status == 'success'` becomes
 * `=status = "success"`.
 */
import { Environment } from "bpmn-elements";
import { evaluate as feelEvaluate } from "feelin";

export interface ExpressionsHandler {
  resolveExpression(expression: string, context?: unknown, fnContext?: unknown): unknown;
  isExpression?(text: string): boolean;
  hasExpression?(text: string): boolean;
}

export interface FeelWarning {
  expression: string;
  message: string;
}

export interface CamundaExpressionOptions {
  /**
   * Called for FEEL warnings, chiefly "Variable 'x' not found" -- almost always a
   * modelling mistake on a gateway, and invisible otherwise since FEEL is total.
   */
  onWarning?: (warning: FeelWarning) => void;
}

/**
 * Roots owned by bpmn-elements itself. `environment.services.foo` resolves to a
 * function, `content.id` to message data; FEEL knows about neither, so these keep
 * going to the default handler.
 */
const ENGINE_ROOTS = /^(environment|content|properties|fields)\b/;

export function isEngineExpression(body: string): boolean {
  return ENGINE_ROOTS.test(body.trim());
}

/**
 * Camunda 8 writes an expression as `=<feel>`. Recognising it matters twice
 * over: bpmn-elements asks `isExpression` before it will evaluate a condition at
 * all, and a condition it does not recognise is treated as a non-empty literal,
 * which is truthy -- so an unrecognised gateway condition silently takes every
 * branch.
 */
export function isFeelExpression(text: unknown): boolean {
  return typeof text === "string" && text.trimStart().startsWith("=");
}

/** The FEEL body of an expression in either supported spelling, if it is one. */
export function expressionBody(text: string): string | null {
  const wrapped = /^\s*\$\{([\s\S]+)\}\s*$/.exec(text ?? "");
  if (wrapped) return wrapped[1] as string;
  const trimmed = (text ?? "").trimStart();
  if (trimmed.startsWith("=")) return trimmed.slice(1);
  return null;
}

/**
 * Names that would otherwise resolve through Object.prototype and hand a diagram
 * a live host function -- `constructor.constructor` is the `Function`
 * constructor. Shadowing them as own properties makes every lookup return null.
 * A null prototype on the context object is *not* sufficient: feelin resolves
 * names against a scope it assembles itself.
 */
const SAFE_SHADOWS = [
  "constructor",
  "__proto__",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

/** Everything a FEEL expression in a diagram may see. */
export function feelContext(context: unknown): Record<string, unknown> {
  const scope = (context ?? {}) as {
    environment?: { variables?: Record<string, unknown>; output?: Record<string, unknown> };
    content?: Record<string, unknown>;
  };

  const safe = Object.create(null) as Record<string, unknown>;
  for (const name of SAFE_SHADOWS) {
    // `__proto__` cannot be assigned through `=` on an ordinary object, and
    // defineProperty is exact about creating an own, non-magical property.
    Object.defineProperty(safe, name, { value: null, enumerable: true, writable: true, configurable: true });
  }

  return Object.assign(safe, {
    // Bare names resolve to process variables, matching how a modeller thinks.
    ...(scope.environment?.variables ?? {}),
    // Values published by earlier activities live in the shared `output` scope
    // (Environment.clone copies `variables` by value but shares `output`), so a
    // gateway condition must see them under their bare names too.
    ...(scope.environment?.output ?? {}),
    ...(scope.content?.output && typeof scope.content.output === "object"
      ? (scope.content.output as Record<string, unknown>)
      : {}),
    // ...and the engine scopes stay reachable under explicit names.
    variables: scope.environment?.variables ?? {},
    output: scope.environment?.output ?? {},
    content: scope.content ?? {},
  });
}

interface FeelResult {
  value?: unknown;
  warnings?: Array<{ message?: string }>;
}

/** Evaluate one FEEL expression body against a resolution context. */
export function evaluateFeel(
  body: string,
  context: unknown,
  onWarning?: (warning: FeelWarning) => void,
): unknown {
  const result = feelEvaluate(body, feelContext(context)) as unknown;
  // feelin >= 6 returns { value, warnings }; older builds returned the value.
  if (result && typeof result === "object" && "value" in (result as object)) {
    const typed = result as FeelResult;
    for (const warning of typed.warnings ?? []) {
      if (warning.message) onWarning?.({ expression: body, message: warning.message });
    }
    return typed.value;
  }
  return result;
}

/**
 * The engine's expression handler: FEEL for diagram expressions, bpmn-elements'
 * own handler for engine-internal references and string interpolation.
 */
export function camundaExpressions(options: CamundaExpressionOptions = {}): ExpressionsHandler {
  // bpmn-elements does not export its Expressions factory, but every Environment
  // carries the default handler, so borrow one from a throwaway environment.
  const base = new (Environment as unknown as new (o: unknown) => { expressions: ExpressionsHandler })({})
    .expressions;

  return {
    isExpression(text: string): boolean {
      return isFeelExpression(text) || Boolean(base.isExpression?.(text));
    },
    hasExpression(text: string): boolean {
      return isFeelExpression(text) || Boolean(base.hasExpression?.(text));
    },
    resolveExpression(expression: string, context?: unknown, fnContext?: unknown): unknown {
      const body = expressionBody(expression);
      if (body !== null && !isEngineExpression(body)) {
        return evaluateFeel(body, context, options.onWarning);
      }
      // Interpolated strings and engine-internal references.
      return base.resolveExpression(expression, context, fnContext);
    },
  };
}
