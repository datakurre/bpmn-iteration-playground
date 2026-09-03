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

const BASE_RULES = {
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
} as const;

const CONFIG = { extends: "bpmnlint:recommended", rules: BASE_RULES };

/**
 * The same ruleset, minus the rules that only make sense against a finished
 * document -- `checkSplice`/`checkMigration` (`graph.ts`) validate a
 * fragment mid-construction, one `graph:extend` at a time, so it is
 * routinely (and legitimately) unterminated: the architect appends a task
 * "after" the last node without yet wiring an end event, closing the gap in
 * a later turn. Rejecting that would break every incremental build, not
 * just bad ones.
 *
 *  - `no-bpmndi` / `local/expanded-subprocesses` / `local/label-layout`: all
 *    three read `<bpmndi:*>` shapes to do their job -- inherited (or, for
 *    the local rules, applied) as `'error'` in `CONFIG` above since
 *    `promote` (and `make lint-bpmn`) only ever see a document that has
 *    already been through `graph:layout`, so every element genuinely should
 *    have a diagram shape by then. Pre-layout there is no DI at all yet, by
 *    construction, so all three would reject every splice outright,
 *    DI-complete or not. `local/label-layout` specifically (issue #106):
 *    it only fires for a named gateway or event (a task's label lives
 *    inside its own bounds, so it never trips), so the failure was
 *    selective -- a splice could add a gateway or event only by leaving it
 *    unnamed, fighting `label-required` telling the model to name it.
 *    `ensureLabelDi` runs as part of `graph:layout`, so by then the DI
 *    genuinely should be there, same as `no-bpmndi`.
 *  - `end-event-required` / `no-implicit-end` / `start-event-required` /
 *    `no-disconnected` / `no-implicit-start`: flag a process, or a flow
 *    node, that doesn't yet reach an end event, or a process with no start
 *    event, or (the degenerate case: a session's own graph right after
 *    `graph-agent init`, a single `bpmn:StartEvent` and nothing else) a node
 *    with neither -- every one of those is true of a legitimate WIP
 *    fragment before its closing op (or, for `createProcess`, before
 *    anything has been inserted into the sibling process it just created),
 *    not just a broken one. `no-implicit-start` specifically: unlike
 *    `fake-join`, a node with no incoming flow is not a runtime hazard --
 *    bpmn-elements only ever activates a node by token arrival, so an
 *    unwired one is inert, not spuriously triggered; it just hasn't been
 *    connected into the flow by a later op yet.
 *
 * Everything else still applies, including what issue #104 is actually
 * about: `fake-join` and `no-implicit-split` catch a splice that would
 * double-run an activity the moment it's introduced, whether or not the
 * graph is finished yet.
 */
const SEMANTIC_CONFIG = {
  extends: "bpmnlint:recommended",
  rules: {
    ...BASE_RULES,
    "no-bpmndi": "off",
    "local/expanded-subprocesses": "off",
    "local/label-layout": "off",
    "end-event-required": "off",
    "no-implicit-end": "off",
    "start-event-required": "off",
    "no-disconnected": "off",
    "no-implicit-start": "off",
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

async function runLint(xml: string, config: Record<string, unknown>): Promise<LintReport> {
  const moddle = new BpmnModdle(MODDLE_OPTIONS);
  const { rootElement } = await moddle.fromXML(xml);
  const linter = new Linter({ config, resolver: withLocalRules(new NodeResolver()) });
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

/** The full ruleset, `no-bpmndi` included -- for a document that has already been through `graph:layout` (`promote`, `make lint-bpmn`). */
export async function lintBpmn(xml: string): Promise<LintReport> {
  return runLint(xml, CONFIG);
}

/** Every rule except the DI- and completeness-only ones a WIP fragment can't satisfy yet -- for `checkSplice`/`checkMigration` (issue #104). See `SEMANTIC_CONFIG`'s own comment for why. */
export async function lintBpmnSemantics(xml: string): Promise<LintReport> {
  return runLint(xml, SEMANTIC_CONFIG);
}
