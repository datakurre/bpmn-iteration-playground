/**
 * Minimal declarations for dependencies whose shipped types do not cover the
 * entry points this project uses.
 */

// bpmn-moddle ships its types under the `bpmn-moddle/types` subpath only, so the
// default import has no declaration. Only the members used here are described.
declare module "bpmn-moddle" {
  export interface ModdleElement {
    $type?: string;
    id?: string;
    [key: string]: unknown;
  }
  export interface ParseResult {
    rootElement: ModdleElement;
    elementsById: Record<string, ModdleElement>;
    warnings: unknown[];
    [key: string]: unknown;
  }
  // dist/index.js exports `BpmnModdle` as a named binding only -- there is no
  // default export, so `import BpmnModdle from "bpmn-moddle"` fails at runtime.
  export class BpmnModdle {
    constructor(options?: Record<string, unknown>);
    fromXML(xml: string, typeName?: string): Promise<ParseResult>;
    toXML(element: unknown, options?: Record<string, unknown>): Promise<{ xml: string }>;
    // Inherited from the base `Moddle` class -- builds a detached moddle
    // object of the given type, the same primitive bpmn-js's own
    // `BpmnFactory.create` uses to construct new elements live in the editor.
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
  }
}

declare module "zeebe-bpmn-moddle/resources/zeebe.json" {
  const descriptor: Record<string, unknown>;
  export default descriptor;
}

// bpmnlint ships no types at all; only the entry points src/agent/bpmn-lint.ts
// and scripts/bpmn-tools.mjs use are described.
declare module "bpmnlint" {
  export interface LintReportEntry {
    category: string;
    id?: string;
    message: string;
    [key: string]: unknown;
  }
  export class Linter {
    constructor(options: { config: Record<string, unknown>; resolver: unknown });
    lint(rootElement: unknown): Promise<Record<string, LintReportEntry[]>>;
  }
}

declare module "bpmnlint/lib/resolver/node-resolver.js" {
  export default class NodeResolver {
    constructor();
    resolveRule(pkg: string, ruleName: string): unknown;
    resolveConfig(pkg: string, configName: string): unknown;
  }
}
