import type { BpmnDiagramInstance } from "./bpmn-types";
import { $ } from "./dom";

export interface ZoomControlIds {
  zoomIn: string;
  zoomOut: string;
  fit: string;
  reset: string;
  minimap: string;
}

export function fitDiagram(instance: BpmnDiagramInstance | null): void {
  if (!instance) return;
  try {
    instance.get("canvas").zoom("fit-viewport", "auto");
  } catch {
    // canvas not attached/ready yet
  }
}

export function wireZoomControls(getInstance: () => BpmnDiagramInstance | null, ids: ZoomControlIds): void {
  const zoomIn = $(ids.zoomIn);
  const zoomOut = $(ids.zoomOut);
  const fit = $(ids.fit);
  const reset = $(ids.reset);
  const minimapBtn = $(ids.minimap);

  if (zoomIn) {
    zoomIn.onclick = () => {
      const instance = getInstance();
      if (!instance) return;
      try {
        instance.get("zoomScroll").stepZoom(1);
      } catch {
        const canvas = instance.get("canvas");
        canvas.zoom(canvas.zoom() * 1.2);
      }
    };
  }
  if (zoomOut) {
    zoomOut.onclick = () => {
      const instance = getInstance();
      if (!instance) return;
      try {
        instance.get("zoomScroll").stepZoom(-1);
      } catch {
        const canvas = instance.get("canvas");
        canvas.zoom(canvas.zoom() / 1.2);
      }
    };
  }
  if (fit) {
    fit.onclick = () => fitDiagram(getInstance());
  }
  if (reset) {
    reset.onclick = () => {
      const instance = getInstance();
      if (!instance) return;
      try {
        instance.get("canvas").zoom(1.0);
      } catch {
        // ignore
      }
    };
  }
  if (minimapBtn) {
    minimapBtn.onclick = () => {
      const instance = getInstance();
      if (!instance) return;
      try {
        const minimap = instance.get("minimap");
        minimap.toggle();
        minimapBtn.classList.toggle("active", minimap.isOpen());
      } catch {
        // ignore
      }
    };
  }
}
