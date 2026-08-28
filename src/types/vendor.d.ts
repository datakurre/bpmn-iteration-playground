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
  }
}

declare module "zeebe-bpmn-moddle/resources/zeebe.json" {
  const descriptor: Record<string, unknown>;
  export default descriptor;
}
