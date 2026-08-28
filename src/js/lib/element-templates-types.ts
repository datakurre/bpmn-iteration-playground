// Minimal shape of a bpmn-js element template JSON document, typed only for the
// fields this project's own code and authored templates actually read/write.
// See @camunda/element-templates-json-schema for the full schema.

export interface TemplateElementType {
  value?: string;
  eventDefinition?: string;
}

export interface ElementTemplateIcon {
  contents: string;
}

export interface ElementTemplateBinding {
  type: string;
  name?: string;
}

export interface ElementTemplateProperty {
  label?: string;
  type?: string;
  value?: string | boolean | number;
  editable?: boolean;
  binding: ElementTemplateBinding;
  [key: string]: unknown;
}

export interface ElementTemplate {
  $schema?: string;
  id: string;
  name: string;
  version?: number;
  description?: string;
  appliesTo: string[];
  elementType?: TemplateElementType;
  icon?: ElementTemplateIcon;
  properties: ElementTemplateProperty[];
  [key: string]: unknown;
}
