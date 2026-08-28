import camundaModdleDescriptor from "camunda-bpmn-moddle/resources/camunda.json";
import type { ModdleDescriptor, ModdleTypeDescriptor } from "./moddle-types";

// Extends the installed camunda-bpmn-moddle descriptor with modelerTemplateIcon
// support (needed by @bpmn-io/element-template-icon-renderer), by augmenting the
// existing TemplateSupported abstract type in place. Registering a second moddle
// extension under the same "camunda" prefix instead would fail at runtime with
// "package with prefix <camunda> already defined".
const descriptor = camundaModdleDescriptor as ModdleDescriptor;
const enhanced: ModdleDescriptor = JSON.parse(JSON.stringify(descriptor));

const templateSupported = enhanced.types.find((t: ModdleTypeDescriptor) => t.name === "TemplateSupported");
if (templateSupported) {
  templateSupported.properties.push({
    name: "modelerTemplateIcon",
    isAttr: true,
    type: "String",
  });
}

export default enhanced;
