// Minimal shape of a moddle JSON descriptor (e.g. camunda-bpmn-moddle's
// resources/camunda.json), typed only for the surface camunda-with-icon-moddle.ts
// actually reads/mutates.

export interface ModdlePropertyDescriptor {
  name: string;
  isAttr?: boolean;
  type: string;
}

export interface ModdleTypeDescriptor {
  name: string;
  isAbstract?: boolean;
  extends?: string[];
  properties: ModdlePropertyDescriptor[];
}

export interface ModdleDescriptor {
  name: string;
  uri: string;
  prefix: string;
  types: ModdleTypeDescriptor[];
}
