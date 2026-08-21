import { describe, it, expect, vi } from "vitest";
import { fitDiagram, wireZoomControls } from "./bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "./bpmn-types";

function fakeInstance(overrides: Partial<Record<string, unknown>> = {}): BpmnDiagramInstance {
  const canvas = {
    zoom: vi.fn((z?: number | string) => (typeof z === "number" ? z : 1)),
    resized: vi.fn(),
    addMarker: vi.fn(),
    removeMarker: vi.fn(),
  };
  const services: Record<string, unknown> = {
    canvas,
    zoomScroll: { stepZoom: vi.fn() },
    minimap: { toggle: vi.fn(), isOpen: vi.fn(() => false) },
    commandStack: { undo: vi.fn(), redo: vi.fn() },
    ...overrides,
  };
  return {
    importXML: vi.fn(),
    saveXML: vi.fn(),
    attachTo: vi.fn(),
    destroy: vi.fn(),
    get: ((name: string) => services[name]) as BpmnDiagramInstance["get"],
  };
}

function setupZoomButtons(): void {
  document.body.innerHTML = `
    <button id="zoom-in"></button>
    <button id="zoom-out"></button>
    <button id="fit"></button>
    <button id="reset"></button>
    <button id="minimap"></button>
  `;
}

const ids = { zoomIn: "zoom-in", zoomOut: "zoom-out", fit: "fit", reset: "reset", minimap: "minimap" };

describe("fitDiagram", () => {
  it("zooms the canvas to fit-viewport", () => {
    const instance = fakeInstance();
    fitDiagram(instance);
    expect(instance.get("canvas").zoom).toHaveBeenCalledWith("fit-viewport", "auto");
  });

  it("does nothing for a null instance", () => {
    expect(() => fitDiagram(null)).not.toThrow();
  });

  it("swallows errors from a canvas not yet attached", () => {
    const instance = fakeInstance();
    (instance.get("canvas").zoom as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("not attached");
    });
    expect(() => fitDiagram(instance)).not.toThrow();
  });
});

describe("wireZoomControls", () => {
  it("uses zoomScroll.stepZoom when available", () => {
    setupZoomButtons();
    const instance = fakeInstance();
    wireZoomControls(() => instance, ids);

    document.getElementById("zoom-in")?.click();
    expect(instance.get("zoomScroll").stepZoom).toHaveBeenCalledWith(1);

    document.getElementById("zoom-out")?.click();
    expect(instance.get("zoomScroll").stepZoom).toHaveBeenCalledWith(-1);
  });

  it("falls back to manual canvas zoom when zoomScroll throws", () => {
    setupZoomButtons();
    const instance = fakeInstance({
      zoomScroll: {
        stepZoom: vi.fn(() => {
          throw new Error("no zoomScroll");
        }),
      },
    });
    wireZoomControls(() => instance, ids);

    document.getElementById("zoom-in")?.click();
    expect(instance.get("canvas").zoom).toHaveBeenCalled();
  });

  it("resets zoom to 1.0", () => {
    setupZoomButtons();
    const instance = fakeInstance();
    wireZoomControls(() => instance, ids);
    document.getElementById("reset")?.click();
    expect(instance.get("canvas").zoom).toHaveBeenCalledWith(1.0);
  });

  it("toggles the minimap and reflects isOpen() on the button class", () => {
    setupZoomButtons();
    const isOpen = vi.fn(() => true);
    const instance = fakeInstance({ minimap: { toggle: vi.fn(), isOpen } });
    wireZoomControls(() => instance, ids);
    const btn = document.getElementById("minimap") as HTMLElement;
    btn.click();
    expect(instance.get("minimap").toggle).toHaveBeenCalled();
    expect(btn.classList.contains("active")).toBe(true);
  });

  it("no-ops every control when getInstance() returns null", () => {
    setupZoomButtons();
    wireZoomControls(() => null, ids);
    Object.values(ids).forEach((id) => expect(() => document.getElementById(id)?.click()).not.toThrow());
  });
});
