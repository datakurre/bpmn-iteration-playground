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
}

declare module "camunda-bpmn-moddle/resources/camunda.json" {
  import type { ModdleDescriptor } from "../lib/moddle-types";
  const camundaModdleDescriptor: ModdleDescriptor;
  export default camundaModdleDescriptor;
}

declare module "bpmn-auto-layout" {
  export function layoutProcess(xml: string): Promise<string>;
}

declare module "bpmn-js/lib/util/ModelUtil" {
  interface BusinessObject {
    set(key: string, value: unknown): void;
    get(key: string): unknown;
  }
  export function getBusinessObject(element: unknown): BusinessObject;
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

// vendor/operaton-element-templates, aliased over the package name it publishes
// under (see scripts/build-assets.mjs). Typed against the actual named exports of
// its dist/index.esm.js, not the upstream bpmn-js-element-templates API surface,
// since this is the Operaton/Camunda 7 fork.
declare module "bpmn-js-element-templates" {
  export const ElementTemplatesCoreModule: unknown;
  export const ElementTemplatesPropertiesProviderModule: unknown;
}

declare module "@bpmn-io/element-template-chooser" {
  const ElementTemplateChooserModule: unknown;
  export default ElementTemplateChooserModule;
}

declare module "@bpmn-io/element-template-icon-renderer" {
  const ElementTemplateIconRendererModule: unknown;
  export default ElementTemplateIconRendererModule;
}
