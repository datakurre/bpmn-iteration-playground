/**
 * The same bpmnlint check `make lint-bpmn` (`scripts/bpmn-tools.mjs`) runs
 * over `workflows/*.bpmn`, importable so `graph-agent promote` (issue #55)
 * can refuse to write a graph to the shared library that would fail it.
 *
 * Kept in sync with `scripts/bpmn-tools.mjs`'s own `CONFIG` by hand --
 * that script stays a standalone `.mjs` (no script in this repo imports from
 * `src/`), so the ruleset is duplicated rather than shared outright.
 */
import { BpmnModdle } from "bpmn-moddle";
import { Linter } from "bpmnlint";
import NodeResolver from "bpmnlint/lib/resolver/node-resolver.js";
import { MODDLE_OPTIONS } from "./graph.ts";

const CONFIG = {
  extends: "bpmnlint:recommended",
  rules: {
    "label-required": "warn",
    "no-overlapping-elements": "off",
    "no-disconnected": "error",
    "no-implicit-split": "error",
    "no-implicit-end": "error",
    "no-implicit-start": "error",
    "no-duplicate-sequence-flows": "error",
    "start-event-required": "error",
    "end-event-required": "error",
    "conditional-flows": "error",
    "fake-join": "info",
    "no-inclusive-gateway": "warn",
    "superfluous-gateway": "warn",
  },
};

export interface LintReport {
  errors: number;
  lines: string[];
}

export async function lintBpmn(xml: string): Promise<LintReport> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml);
  const linter = new Linter({ config: CONFIG, resolver: new NodeResolver() });
  const reports = await linter.lint(rootElement);

  const lines: string[] = [];
  let errors = 0;
  for (const [rule, entries] of Object.entries(reports as Record<string, Array<{ category: string; id?: string; message: string }>>)) {
    for (const entry of entries) {
      const level = entry.category === "error" ? "error" : entry.category;
      if (level === "error") errors += 1;
      lines.push(`${level.padEnd(5)} ${entry.id ?? "-"}  ${entry.message}  (${rule})`);
    }
  }
  return { errors, lines };
}
