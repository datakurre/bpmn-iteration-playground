import BpmnModeler from "bpmn-js/lib/Modeler";
import minimapModule from "diagram-js-minimap";
import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
  CamundaPlatformPropertiesProviderModule,
} from "bpmn-js-properties-panel";
import camundaModdleDescriptor from "camunda-bpmn-moddle/resources/camunda.json";
import { layoutProcess } from "bpmn-auto-layout";

window.BpmnModeler = BpmnModeler;
window.BpmnJS = BpmnModeler;
window.minimapModule = minimapModule;
window.BpmnPropertiesPanelModule = BpmnPropertiesPanelModule;
window.BpmnPropertiesProviderModule = BpmnPropertiesProviderModule;
window.CamundaPlatformPropertiesProviderModule = CamundaPlatformPropertiesProviderModule;
window.camundaModdleDescriptor = camundaModdleDescriptor;
window.AutoLayout = { layoutProcess };
