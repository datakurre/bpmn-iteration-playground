/**
 * Camunda 8 (Zeebe) flavour for bpmn-engine.
 *
 * bpmn-engine implements the BPMN 2.0 scheme, not Camunda semantics: it parses
 * the `zeebe:` namespace once zeebe-bpmn-moddle's descriptor is passed as
 * `moddleOptions.zeebe`, but nothing acts on those attributes. This module
 * supplies the behaviour for the subset the workflow graphs use:
 *
 *   zeebe:taskDefinition  -> `type` selects the harness (C8's job type)
 *   zeebe:taskHeaders     -> static per-activity config, C8's idiomatic place for it
 *   zeebe:properties      -> the same, for anything a header cannot carry
 *   zeebe:ioMapping       -> FEEL input/output variable mapping
 *   zeebe:formDefinition  -> user task forms (form-js, by id or external reference)
 *
 * Note the direction of an ioMapping, which is the reverse of Camunda 7's:
 * `source` is the FEEL expression to evaluate, `target` is the variable it lands
 * in. Expressions carry C8's leading `=`.
 */

export interface ZeebeHeader {
  key?: string;
  value?: string;
}

export interface ZeebeProperty {
  name?: string;
  value?: string;
}

export interface ZeebeMappingParameter {
  /** FEEL expression, conventionally written with a leading `=`. */
  source?: string;
  /** Variable name the evaluated source is bound to. */
  target?: string;
}

export interface ZeebeFormDefinition {
  formId?: string;
  externalReference?: string;
  formKey?: string;
}

interface ExtensionElementValue {
  $type?: string;
  type?: string;
  retries?: string;
  values?: Array<Record<string, unknown>>;
  inputParameters?: ZeebeMappingParameter[];
  outputParameters?: ZeebeMappingParameter[];
  formId?: string;
  externalReference?: string;
  formKey?: string;
}

interface ActivityBehaviour {
  extensionElements?: { values?: ExtensionElementValue[] };
  [key: string]: unknown;
}

export interface ActivityLike {
  id: string;
  type: string;
  name?: string;
  behaviour: ActivityBehaviour;
}

/** Evaluates a FEEL expression against a scope. Injected so this module stays pure. */
export type FeelEvaluator = (expression: string, scope: Record<string, unknown>) => unknown;

function extensionValues(activity: ActivityLike, type: string): ExtensionElementValue[] {
  const values = activity.behaviour?.extensionElements?.values ?? [];
  return values.filter((v) => v.$type === type);
}

/**
 * The job type, which selects the harness: `agent:turn`, `agent:tool`,
 * `graph:extend`, and so on. In Camunda 8 this is what a job worker subscribes
 * to, which is exactly the dispatch key this project needs.
 */
export function harnessOf(activity: ActivityLike): string | undefined {
  return extensionValues(activity, "zeebe:TaskDefinition")[0]?.type;
}

/** How many times C8 would retry the job. Recorded, not yet enforced. */
export function retriesOf(activity: ActivityLike): number | undefined {
  const raw = extensionValues(activity, "zeebe:TaskDefinition")[0]?.retries;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Static per-activity configuration, merged from `zeebe:taskHeaders` (the
 * idiomatic C8 place, and what Camunda's own connectors use) and
 * `zeebe:properties`. Headers win on a clash.
 */
export function activityProperties(activity: ActivityLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const element of extensionValues(activity, "zeebe:Properties")) {
    for (const property of (element.values ?? []) as ZeebeProperty[]) {
      if (property.name) out[property.name] = property.value ?? "";
    }
  }
  for (const element of extensionValues(activity, "zeebe:TaskHeaders")) {
    for (const header of (element.values ?? []) as ZeebeHeader[]) {
      if (header.key) out[header.key] = header.value ?? "";
    }
  }
  return out;
}

export function formDefinition(activity: ActivityLike): ZeebeFormDefinition | undefined {
  const element = extensionValues(activity, "zeebe:FormDefinition")[0];
  if (!element) return undefined;
  return {
    ...(element.formId === undefined ? {} : { formId: element.formId }),
    ...(element.externalReference === undefined ? {} : { externalReference: element.externalReference }),
    ...(element.formKey === undefined ? {} : { formKey: element.formKey }),
  };
}

export interface IoMapping {
  input: ZeebeMappingParameter[];
  output: ZeebeMappingParameter[];
}

export function ioMapping(activity: ActivityLike): IoMapping {
  const input: ZeebeMappingParameter[] = [];
  const output: ZeebeMappingParameter[] = [];
  for (const element of extensionValues(activity, "zeebe:IoMapping")) {
    input.push(...(element.inputParameters ?? []));
    output.push(...(element.outputParameters ?? []));
  }
  return { input, output };
}

/** Strip C8's leading `=` from an expression, if present. */
export function feelBody(source: string): string {
  return source.startsWith("=") ? source.slice(1) : source;
}

/** Build the payload an activity's harness receives, from `zeebe:input`. */
export function resolveInput(
  activity: ActivityLike,
  scope: Record<string, unknown>,
  evaluate: FeelEvaluator,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const parameter of ioMapping(activity).input) {
    if (!parameter.target || parameter.source === undefined) continue;
    payload[parameter.target] = evaluate(feelBody(parameter.source), scope);
  }
  return payload;
}

/**
 * Map a harness result onto process variables, from `zeebe:output`.
 *
 * The source expression is evaluated against the job result, so
 * `<zeebe:output source="=status" target="agent_status" />` publishes the
 * result's `status` as the variable `agent_status`.
 */
export function resolveOutput(
  activity: ActivityLike,
  result: unknown,
  evaluate: FeelEvaluator,
): Record<string, unknown> {
  const scope = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const published: Record<string, unknown> = {};
  for (const parameter of ioMapping(activity).output) {
    if (!parameter.target || parameter.source === undefined) continue;
    published[parameter.target] = evaluate(feelBody(parameter.source), scope);
  }
  return published;
}
