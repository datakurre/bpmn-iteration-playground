// bpmn-js and its ecosystem (bpmn-js-properties-panel, camunda-bpmn-moddle,
// bpmn-auto-layout, diagram-js-minimap) ship no type declarations at all, and no
// `@types/*` package exists for them. These shims type only the surface this
// project actually calls; everything else is intentionally `any` rather than
// a fabricated, likely-wrong signature.

declare module "bpmn-js/lib/NavigatedViewer" {
  import type { BpmnDiagramInstance } from "../lib/bpmn-types";
  const NavigatedViewer: new (options: { container: HTMLElement; additionalModules?: unknown[] }) => BpmnDiagramInstance;
  export default NavigatedViewer;
}

declare module "bpmn-js/lib/Modeler" {
  import type { BpmnDiagramInstance } from "../lib/bpmn-types";
  const Modeler: new (options: { container: HTMLElement; propertiesPanel?: { parent: HTMLElement }; additionalModules?: unknown[]; moddleExtensions?: Record<string, unknown> }) => BpmnDiagramInstance;
  export default Modeler;
}

declare module "diagram-js-minimap" {
  const minimapModule: unknown;
  export default minimapModule;
}

declare module "bpmn-js-properties-panel" {
  export const BpmnPropertiesPanelModule: unknown;
  export const BpmnPropertiesProviderModule: unknown;
  export const CamundaPlatformPropertiesProviderModule: unknown;
}

declare module "camunda-bpmn-moddle/resources/camunda.json" {
  const camundaModdleDescriptor: Record<string, unknown>;
  export default camundaModdleDescriptor;
}

declare module "bpmn-auto-layout" {
  export function layoutProcess(xml: string): Promise<string>;
}

declare module "bpmn-js-create-append-anything" {
  export const CreateAppendAnythingModule: unknown;
  export const CreateAppendElementTemplatesModule: unknown;
  export const RemoveTemplatesModule: unknown;
}

declare module "bpmn-js-token-simulation" {
  const TokenSimulationModule: unknown;
  export default TokenSimulationModule;
}

declare module "bpmn-js-bpmnlint" {
  const BpmnlintModule: unknown;
  export default BpmnlintModule;
}

// bpmnlint itself ships no type declarations. A rule module is a factory
// that `bpmnlint`'s Linter calls with the rule's config value; we only need
// it typed as `unknown` to pass through our own StaticResolver cache.
type BpmnLintRuleFactory = unknown;

declare module "bpmnlint/config/recommended" {
  const recommendedConfig: { rules: Record<string, string> };
  export default recommendedConfig;
}

declare module "bpmnlint/lib/resolver/static-resolver" {
  class StaticResolver {
    constructor(cache: Record<string, BpmnLintRuleFactory>);
  }
  export default StaticResolver;
}

declare module "bpmnlint/rules/*" {
  const rule: BpmnLintRuleFactory;
  export default rule;
}
