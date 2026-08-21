// Minimal, hand-typed surface of the bpmn-js / diagram-js module registry
// actually used by this project. bpmn-js resolves services by string key via
// `.get(name)` with no way to express that generically and precisely, so
// known keys get real types and anything else falls back to `unknown`.

export interface BpmnCanvas {
  zoom(newScale?: number | "fit-viewport", center?: "auto" | { x: number; y: number }): number;
  resized(): void;
  addMarker(elementId: string, marker: string): void;
  removeMarker(elementId: string, marker: string): void;
}

export interface BpmnZoomScroll {
  stepZoom(step: number): void;
}

export interface BpmnMinimap {
  toggle(open?: boolean): void;
  isOpen(): boolean;
}

export interface BpmnCommandStack {
  undo(): void;
  redo(): void;
}

export interface BpmnImportResult {
  warnings: string[];
}

export interface BpmnSaveXmlResult {
  xml: string;
}

export interface BpmnDiagramInstance {
  importXML(xml: string): Promise<BpmnImportResult>;
  saveXML(options?: { format?: boolean }): Promise<BpmnSaveXmlResult>;
  attachTo(element: HTMLElement): void;
  destroy(): void;
  get(name: "canvas"): BpmnCanvas;
  get(name: "zoomScroll"): BpmnZoomScroll;
  get(name: "minimap"): BpmnMinimap;
  get(name: "commandStack"): BpmnCommandStack;
  get(name: string): unknown;
}
