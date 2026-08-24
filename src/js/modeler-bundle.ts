import BpmnModeler from "bpmn-js/lib/Modeler";
import minimapModule from "diagram-js-minimap";
import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
  CamundaPlatformPropertiesProviderModule,
} from "bpmn-js-properties-panel";
import camundaModdleDescriptor from "camunda-bpmn-moddle/resources/camunda.json";
import { layoutProcess } from "bpmn-auto-layout";
import { CreateAppendAnythingModule } from "bpmn-js-create-append-anything";
import TokenSimulationModule from "bpmn-js-token-simulation";
import bpmnlintModule from "bpmn-js-bpmnlint";
import { recommendedLintConfig } from "./lib/bpmnlint-static-config";

window.BpmnModeler = BpmnModeler;
window.BpmnJS = BpmnModeler;
window.minimapModule = minimapModule;
window.BpmnPropertiesPanelModule = BpmnPropertiesPanelModule;
window.BpmnPropertiesProviderModule = BpmnPropertiesProviderModule;
window.CamundaPlatformPropertiesProviderModule = CamundaPlatformPropertiesProviderModule;
window.camundaModdleDescriptor = camundaModdleDescriptor;
window.AutoLayout = { layoutProcess };
window.CreateAppendAnythingModule = CreateAppendAnythingModule;
window.TokenSimulationModule = TokenSimulationModule;
window.BpmnlintModule = bpmnlintModule;
window.BpmnlintRecommendedConfig = recommendedLintConfig;
