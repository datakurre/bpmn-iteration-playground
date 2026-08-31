// Globals attached to `window` by scripts loaded via plain <script src> (the
// viewer/modeler esbuild bundles, and form-js's UMD build) rather than ESM
// `import`, so they can only be declared, never statically resolved.

import type { BpmnDiagramInstance } from "../lib/bpmn-types";
import type { ModdleDescriptor } from "../lib/moddle-types";

export interface FormInstanceState {
  data: Record<string, unknown>;
  errors: Record<string, unknown>;
}

export interface FormSubmitResult {
  data: Record<string, unknown>;
  errors: Record<string, unknown>;
}

export interface FormInstance {
  importSchema(schema: unknown, data?: unknown): Promise<void>;
  /** Triggers field validation and returns the current data -- no submit button in the schema required. */
  submit(): FormSubmitResult;
  destroy(): void;
  _getState(): FormInstanceState;
}

export interface FormJSNamespace {
  Form: new (options: { container: string | HTMLElement }) => FormInstance;
}

declare global {
  interface Window {
    // Set by a tiny inline <script> in the template, before the page bundle loads,
    // since a server-rendered Jinja value can't be baked into a static built bundle.
    __WORKFLOW_ID__?: string;
    BpmnNavigatedViewer?: new (options: { container: HTMLElement; additionalModules?: unknown[] }) => BpmnDiagramInstance;
    BpmnModeler?: new (options: { container: HTMLElement; propertiesPanel?: { parent: HTMLElement }; additionalModules?: unknown[]; moddleExtensions?: Record<string, unknown> }) => BpmnDiagramInstance;
    BpmnJS?: unknown;
    minimapModule?: unknown;
    BpmnPropertiesPanelModule?: unknown;
    BpmnPropertiesProviderModule?: unknown;
    zeebeModdleDescriptor?: ModdleDescriptor;
    AutoLayout?: { layoutProcess(xml: string): Promise<string> };
    FormJS?: FormJSNamespace;
    FormViewer?: FormJSNamespace;
    CreateAppendAnythingModule?: unknown;
    CreateAppendElementTemplatesModule?: unknown;
    TokenSimulationModule?: unknown;
    BpmnlintModule?: unknown;
    BpmnlintRecommendedConfig?: { config: { rules: Record<string, string> }; resolver: unknown };
    ElementTemplatesPropertiesProviderModule?: unknown;
    ElementTemplateChooserModule?: unknown;
    ElementTemplateIconRendererModule?: unknown;
    ElementTemplatesExtendModule?: unknown;
    SupportedElementsRulesModule?: unknown;
  }
}

export {};
