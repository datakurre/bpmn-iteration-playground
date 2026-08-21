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
