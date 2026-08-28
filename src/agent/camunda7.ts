/**
 * Camunda 7 flavour for bpmn-engine.
 *
 * bpmn-engine implements the BPMN 2.0 scheme, not Camunda semantics: it will
 * parse the `camunda:` namespace once camunda-bpmn-moddle's descriptor is passed
 * as `moddleOptions.camunda`, but nothing acts on those attributes. This module
 * supplies the behaviour, for the subset the archived branch's diagrams already
 * use (docs/skills/bpmn-crafting/references/camunda-extensions.md):
 *
 *   camunda:properties      -> activity metadata; `harness` selects the adapter
 *   camunda:inputOutput     -> input/output parameter mapping
 *   camunda:resultVariable  -> publish the whole activity output under one name
 *   camunda:formData        -> user task form fields
 *
 * Expressions stay deliberately small: `${name}` and `${name.path.to.value}`
 * against the merged environment/activity variables, plus literal interpolation.
 * No eval -- the same restriction `resolve_input` had in the Python version.
 */

export interface CamundaProperty {
  name?: string;
  value?: string;
}

export interface CamundaFormField {
  id?: string;
  label?: string;
  type?: string;
  defaultValue?: string;
}

export interface CamundaParameter {
  name?: string;
  value?: string;
  /** `camunda:outputParameter` carries its expression in `source`/`value`. */
  source?: string;
}

interface ExtensionElementValue {
  $type?: string;
  values?: Array<Record<string, unknown>>;
  inputParameters?: CamundaParameter[];
  outputParameters?: CamundaParameter[];
  fields?: CamundaFormField[];
}

interface ActivityBehaviour {
  extensionElements?: { values?: ExtensionElementValue[] };
  resultVariable?: string;
  [key: string]: unknown;
}

export interface ActivityLike {
  id: string;
  type: string;
  name?: string;
  behaviour: ActivityBehaviour;
}

function extensionValues(activity: ActivityLike, type: string): ExtensionElementValue[] {
  const values = activity.behaviour?.extensionElements?.values ?? [];
  return values.filter((v) => v.$type === type);
}

/** `camunda:properties` flattened to a plain record. */
export function camundaProperties(activity: ActivityLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const element of extensionValues(activity, "camunda:Properties")) {
    for (const property of (element.values ?? []) as CamundaProperty[]) {
      if (property.name) out[property.name] = property.value ?? "";
    }
  }
  return out;
}

/** Which adapter runs this activity: `agent:turn`, `agent:tool`, `graph:extend`, ... */
export function harnessOf(activity: ActivityLike): string | undefined {
  const properties = camundaProperties(activity);
  // `harness` is this project's name for it; `harness_type` is what the archived
  // Python diagrams wrote, and those diagrams should keep working.
  return properties.harness ?? properties.harness_type;
}

export function camundaFormFields(activity: ActivityLike): CamundaFormField[] {
  const out: CamundaFormField[] = [];
  for (const element of extensionValues(activity, "camunda:FormData")) {
    out.push(...(element.fields ?? []));
  }
  return out;
}

export interface IoMapping {
  input: CamundaParameter[];
  output: CamundaParameter[];
}

export function camundaIo(activity: ActivityLike): IoMapping {
  const input: CamundaParameter[] = [];
  const output: CamundaParameter[] = [];
  for (const element of extensionValues(activity, "camunda:InputOutput")) {
    input.push(...(element.inputParameters ?? []));
    output.push(...(element.outputParameters ?? []));
  }
  return { input, output };
}

const EXPRESSION = /\$\{([^}]+)\}/g;

/** Follow a dotted path; array indices are numeric segments. */
export function lookup(scope: Record<string, unknown>, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Resolve `${...}` against `scope`. A template that is exactly one expression
 * yields the referenced value with its type intact; anything else interpolates
 * to a string.
 */
export function resolveExpression(template: string, scope: Record<string, unknown>): unknown {
  const whole = /^\$\{([^}]+)\}$/.exec(template.trim());
  if (whole) return lookup(scope, (whole[1] as string).trim());
  return template.replace(EXPRESSION, (_match, path: string) => {
    const value = lookup(scope, path.trim());
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** Build the input payload an activity's harness receives. */
export function resolveInput(activity: ActivityLike, scope: Record<string, unknown>): Record<string, unknown> {
  const { input } = camundaIo(activity);
  const payload: Record<string, unknown> = {};
  for (const parameter of input) {
    if (!parameter.name) continue;
    const template = parameter.value ?? parameter.source;
    payload[parameter.name] = template === undefined ? undefined : resolveExpression(template, scope);
  }
  return payload;
}

/**
 * Map a harness result onto process variables.
 *
 * `camunda:outputParameter name="x" source="${status}"` publishes the result's
 * `status` as variable `x`. `camunda:resultVariable` publishes the whole result.
 */
export function resolveOutput(activity: ActivityLike, result: unknown): Record<string, unknown> {
  const published: Record<string, unknown> = {};
  const resultVariable = activity.behaviour?.resultVariable;
  if (typeof resultVariable === "string" && resultVariable) published[resultVariable] = result;

  const { output } = camundaIo(activity);
  const scope = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  for (const parameter of output) {
    if (!parameter.name) continue;
    const template = parameter.source ?? parameter.value;
    published[parameter.name] = template === undefined ? undefined : resolveExpression(template, scope);
  }
  return published;
}
