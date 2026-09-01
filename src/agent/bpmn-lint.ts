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
import { expandedSubprocesses, onlySupportedElements } from "../js/lib/supported-bpmn-elements.ts";
import { labelLayout } from "../js/lib/bpmn-label-layout.ts";

const CONFIG = {
  extends: "bpmnlint:recommended",
  rules: {
    "label-required": "warn",
    "no-overlapping-elements": "error",
    "no-disconnected": "error",
    "no-implicit-split": "error",
    "no-implicit-end": "error",
    "no-implicit-start": "error",
    "no-duplicate-sequence-flows": "error",
    "start-event-required": "error",
    "end-event-required": "error",
    "conditional-flows": "error",
    // An implicit merge (more than one incoming flow into a plain activity
    // or event) is forbidden, not just flagged: bpmn-elements re-triggers
    // such an activity once per arriving token rather than joining, a real
    // behavioural trap. A drafted fragment that does this is rejected and
    // redrafted, the same as any other structural defect graph:lint catches
    // -- model the merge with an exclusive gateway instead.
    "fake-join": "error",
    "no-inclusive-gateway": "warn",
    "superfluous-gateway": "warn",
    // Restricts creatable/importable elements to what this project's runtime
    // actually supports -- see supported-bpmn-elements.ts.
    "local/only-supported-elements": "error",
    "local/expanded-subprocesses": "error",
    "local/label-layout": "error",
  },
};

/**
 * `NodeResolver` resolves bpmnlint's own bundled rules (and `bpmnlint:recommended`
 * itself) by `require()`-ing real npm packages -- fine for everything `extends`
 * pulls in, but our own `local/only-supported-elements` rule isn't a published
 * plugin package, so `NodeResolver` can't find it (it'd look for a
 * `bpmnlint-plugin-local` package on disk). Delegate everything else to a real
 * `NodeResolver` and intercept only this one rule name -- `bpmnlint` resolves a
 * "local/x" rule name to `pkg: "bpmnlint-plugin-local"` internally
 * (`bpmnlint/lib/linter.js`'s `parseRuleName`), so that's the pkg this checks for.
 */
function withLocalRules(resolver: NodeResolver) {
  return {
    resolveRule(pkg: string, ruleName: string): unknown {
      if (pkg === "bpmnlint-plugin-local" && ruleName === "only-supported-elements") return onlySupportedElements;
      if (pkg === "bpmnlint-plugin-local" && ruleName === "expanded-subprocesses") return expandedSubprocesses;
      if (pkg === "bpmnlint-plugin-local" && ruleName === "label-layout") return labelLayout;
      return resolver.resolveRule(pkg, ruleName);
    },
    resolveConfig(pkg: string, configName: string): unknown {
      return resolver.resolveConfig(pkg, configName);
    },
  };
}

export interface LintReport {
  errors: number;
  lines: string[];
}

export async function lintBpmn(xml: string): Promise<LintReport> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml);
  const linter = new Linter({ config: CONFIG, resolver: withLocalRules(new NodeResolver()) });
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
