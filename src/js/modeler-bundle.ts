import BpmnModeler from "bpmn-js/lib/Modeler";
import minimapModule from "diagram-js-minimap";
import { BpmnPropertiesPanelModule, BpmnPropertiesProviderModule } from "bpmn-js-properties-panel";
// zeebe-bpmn-moddle already declares modelerTemplateIcon on TemplateSupported,
// so the descriptor goes in as published. (camunda-bpmn-moddle did not, which is
// why the Camunda 7 build carried a patched copy.)
import zeebeModdleDescriptor from "zeebe-bpmn-moddle/resources/zeebe.json";
import { layoutProcess } from "bpmn-auto-layout";
import { CreateAppendAnythingModule, CreateAppendElementTemplatesModule } from "bpmn-js-create-append-anything";
import TokenSimulationModule from "bpmn-js-token-simulation";
import bpmnlintModule from "bpmn-js-bpmnlint";
import { recommendedLintConfig } from "./lib/bpmnlint-static-config";
// Camunda 8 flavour: the Cloud provider is the one that understands zeebe:
// bindings, and it brings the FEEL editor widget to every expression field.
import { CloudElementTemplatesPropertiesProviderModule } from "bpmn-js-element-templates";
import ElementTemplateChooserModule from "@bpmn-io/element-template-chooser";
import ElementTemplateIconRendererModule from "@bpmn-io/element-template-icon-renderer";
import { ElementTemplatesExtendModule } from "./lib/element-templates-extend";

window.BpmnModeler = BpmnModeler;
window.BpmnJS = BpmnModeler;
window.minimapModule = minimapModule;
window.BpmnPropertiesPanelModule = BpmnPropertiesPanelModule;
window.BpmnPropertiesProviderModule = BpmnPropertiesProviderModule;
window.zeebeModdleDescriptor = zeebeModdleDescriptor;
window.AutoLayout = { layoutProcess };
window.CreateAppendAnythingModule = CreateAppendAnythingModule;
window.CreateAppendElementTemplatesModule = CreateAppendElementTemplatesModule;
window.TokenSimulationModule = TokenSimulationModule;
window.BpmnlintModule = bpmnlintModule;
window.BpmnlintRecommendedConfig = recommendedLintConfig;
window.ElementTemplatesPropertiesProviderModule = CloudElementTemplatesPropertiesProviderModule;
window.ElementTemplateChooserModule = ElementTemplateChooserModule;
window.ElementTemplateIconRendererModule = ElementTemplateIconRendererModule;
window.ElementTemplatesExtendModule = ElementTemplatesExtendModule;
