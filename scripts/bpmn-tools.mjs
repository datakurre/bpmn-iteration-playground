#!/usr/bin/env node
/**
 * Layout and lint for the workflow graphs.
 *
 * Diagrams in this repo are hand-written semantics plus generated DI: writing
 * <bpmndi:> coordinates by hand is miserable and gets stale the moment a node is
 * spliced in, so `layout` regenerates them from the graph.
 *
 *   node scripts/bpmn-tools.mjs layout <file.bpmn>...   (in place)
 *   node scripts/bpmn-tools.mjs lint   <file.bpmn>...
 *   node scripts/bpmn-tools.mjs check  <file.bpmn>...   (layout + lint)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { layoutProcess } from "bpmn-auto-layout";
import { Linter } from "bpmnlint";
import { BpmnModdle } from "bpmn-moddle";
import zeebe from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };
import NodeResolver from "bpmnlint/lib/resolver/node-resolver.js";

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
    // An implicit merge -- more than one incoming flow into a plain activity
    // or event -- looks like a join but isn't one: bpmn-elements re-triggers
    // the activity once per arriving token instead of waiting for all of
    // them, which is a real behavioural trap for anyone reading the diagram
    // as a BPMN join. Model the merge with an exclusive gateway instead (see
    // any workflows/*.bpmn's gw_*_entry gateways for the pattern) -- forbidden
    // outright, not just flagged, now that every bundled graph does.
    "fake-join": "error",
    "no-inclusive-gateway": "warn",
    "superfluous-gateway": "warn",
    // Restricts creatable/importable elements to what this project's runtime
    // actually supports -- keep in sync with src/js/lib/supported-bpmn-elements.ts
    // (this script deliberately doesn't import from src/, see the file header).
    "local/only-supported-elements": "error",
  },
};

// Mirrors src/js/lib/supported-bpmn-elements.ts's SUPPORTED_ELEMENT_TYPES and
// onlySupportedElements -- see that file for why the allowlist is what it is.
const SUPPORTED_ELEMENT_TYPES = new Set([
  "bpmn:StartEvent",
  "bpmn:EndEvent",
  "bpmn:SequenceFlow",
  "bpmn:ServiceTask",
  "bpmn:UserTask",
  "bpmn:ExclusiveGateway",
  "bpmn:CallActivity",
  "bpmn:SubProcess",
]);

function isAny(node, types) {
  return types.some((type) => (typeof node.$instanceOf === "function" ? node.$instanceOf(type) : node.$type === type));
}

function onlySupportedElements() {
  return {
    check(node, reporter) {
      if (!isAny(node, ["bpmn:FlowElement", "bpmn:Artifact"])) return;
      if (SUPPORTED_ELEMENT_TYPES.has(node.$type)) return;
      reporter.report(
        node.id,
        `Element type <${node.$type}> is not supported by this project's runtime -- allowed types are: ${[...SUPPORTED_ELEMENT_TYPES].sort().join(", ")}`,
      );
    },
  };
}

// See src/agent/bpmn-lint.ts's own withLocalRules for why this wrapper exists:
// NodeResolver can't resolve a rule that isn't a real npm plugin package.
function withLocalRules(resolver) {
  return {
    resolveRule(pkg, ruleName) {
      if (pkg === "bpmnlint-plugin-local" && ruleName === "only-supported-elements") return onlySupportedElements;
      return resolver.resolveRule(pkg, ruleName);
    },
    resolveConfig(pkg, configName) {
      return resolver.resolveConfig(pkg, configName);
    },
  };
}

async function layout(file) {
  const xml = readFileSync(file, "utf8");
  writeFileSync(file, await layoutProcess(xml));
  return `layout  ${file}`;
}

async function lint(file) {
  const moddle = new BpmnModdle({ zeebe });
  const { rootElement } = await moddle.fromXML(readFileSync(file, "utf8"));
  const linter = new Linter({ config: CONFIG, resolver: withLocalRules(new NodeResolver()) });
  const reports = await linter.lint(rootElement);

  const lines = [];
  let errors = 0;
  for (const [rule, entries] of Object.entries(reports)) {
    for (const entry of entries) {
      const level = entry.category === "error" ? "error" : entry.category;
      if (level === "error") errors += 1;
      lines.push(`  ${level.padEnd(5)} ${entry.id ?? "-"}  ${entry.message}  (${rule})`);
    }
  }
  return { file, errors, lines };
}

const [command, ...files] = process.argv.slice(2);
if (!command || files.length === 0) {
  console.error("usage: bpmn-tools.mjs <layout|lint|check> <file.bpmn>...");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  if (command === "layout" || command === "check") console.log(await layout(file));
  if (command === "lint" || command === "check") {
    const result = await lint(file);
    console.log(`lint    ${file}${result.lines.length ? "" : "  clean"}`);
    for (const line of result.lines) console.log(line);
    failed += result.errors;
  }
}
if (failed > 0) {
  console.error(`\n${failed} lint error(s)`);
  process.exit(1);
}
