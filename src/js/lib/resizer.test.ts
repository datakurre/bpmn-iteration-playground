import { describe, it, expect, vi, beforeEach } from "vitest";
import { initResizer } from "./resizer";

function drag(handle: HTMLElement, startY: number, endY: number): void {
  handle.dispatchEvent(new MouseEvent("mousedown", { clientY: startY, clientX: startY, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientY: endY, clientX: endY, bubbles: true, cancelable: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { clientY: endY, clientX: endY, bubbles: true, cancelable: true }));
}

let handle: HTMLElement;
let target: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="handle"></div><div id="target"></div>';
  handle = document.getElementById("handle") as HTMLElement;
  target = document.getElementById("target") as HTMLElement;
  Object.defineProperty(target, "offsetHeight", { value: 400, configurable: true });
  Object.defineProperty(target, "offsetWidth", { value: 400, configurable: true });
});

describe("initResizer (vertical)", () => {
  it("grows the target height by the drag delta", () => {
    initResizer(handle, target, { axis: "vertical", min: 100, max: 1000 });
    drag(handle, 100, 150);
    expect(target.style.height).toBe("450px");
    expect(target.style.minHeight).toBe("450px");
  });

  it("clamps to the configured min/max", () => {
    initResizer(handle, target, { axis: "vertical", min: 100, max: 420 });
    drag(handle, 100, 500);
    expect(target.style.height).toBe("420px");
  });

  it("calls onResize during the drag and onEnd on release", () => {
    const onResize = vi.fn();
    const onEnd = vi.fn();
    initResizer(handle, target, { axis: "vertical", min: 100, max: 1000, onResize, onEnd });
    drag(handle, 100, 150);
    expect(onResize).toHaveBeenCalledWith(450);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("ignores movement before a drag has started", () => {
    initResizer(handle, target, { axis: "vertical", min: 100, max: 1000 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: 500, bubbles: true }));
    expect(target.style.height).toBe("");
  });
});

describe("initResizer (horizontal, inverted)", () => {
  it("grows width when dragging toward the panel (invert)", () => {
    initResizer(handle, target, { axis: "horizontal", min: 100, max: 1000, invert: true });
    drag(handle, 300, 250); // dragged left by 50 -> width grows by 50
    expect(target.style.width).toBe("450px");
  });
});
