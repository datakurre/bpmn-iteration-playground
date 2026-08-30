/**
 * Turning a `zeebe:userTaskForm` schema (form-js JSON, as `pendingGates`
 * hands it back -- see `src/agent/graph.ts`) into the plain question list the
 * TUI's gate wizard prompts one at a time. No terminal, no form-js: this is a
 * pure function so the wizard's field order and labels are testable without
 * either.
 */

export interface FormField {
  key: string;
  label: string;
}

/** Component types with no value of their own -- asking for one would just confuse the wizard. */
const NON_INPUT_TYPES = new Set(["text", "separator", "spacer", "button", "image", "html", "iframe", "table"]);

/**
 * Extracts one question per form-js component that actually has a `key`
 * (skips layout-only components). Falls back to a single generic `value`
 * field if the schema does not parse or names no fields at all -- an
 * activity still has to be answered even when its form is malformed or
 * missing, the same way `pendingGates` still reports the gate.
 */
export function formFields(schema: string, fallbackLabel: string): FormField[] {
  try {
    const parsed = JSON.parse(schema) as { components?: unknown };
    const components = Array.isArray(parsed.components) ? parsed.components : [];
    const fields: FormField[] = [];
    for (const component of components) {
      if (!component || typeof component !== "object") continue;
      const record = component as Record<string, unknown>;
      if (typeof record.key !== "string") continue;
      if (typeof record.type === "string" && NON_INPUT_TYPES.has(record.type)) continue;
      fields.push({ key: record.key, label: typeof record.label === "string" ? record.label : record.key });
    }
    if (fields.length > 0) return fields;
  } catch {
    // Falls through to the generic single-field question below.
  }
  return [{ key: "value", label: fallbackLabel }];
}
