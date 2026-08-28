// Minimal shape of a moddle JSON descriptor (e.g. zeebe-bpmn-moddle's
// resources/zeebe.json), typed only for the surface the editor bundle touches.
// Not every type in a descriptor declares properties, so that field is optional.

export interface ModdlePropertyDescriptor {
  name: string;
  type: string;
  isAttr?: boolean;
  isMany?: boolean;
  isBody?: boolean;
  [key: string]: unknown;
}

export interface ModdleTypeDescriptor {
  name: string;
  properties?: ModdlePropertyDescriptor[];
  superClass?: string[];
  extends?: string[];
  isAbstract?: boolean;
  [key: string]: unknown;
}

export interface ModdleDescriptor {
  name?: string;
  uri?: string;
  prefix?: string;
  types: ModdleTypeDescriptor[];
  [key: string]: unknown;
}
