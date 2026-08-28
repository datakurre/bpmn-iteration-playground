// Generic pointer/mouse/touch drag-resizer, unifying the vertical resizer
// (instance/history_detail BPMN canvas panels) and the horizontal resizer
// (editor properties panel) that were previously near-duplicated per page.

export type ResizeAxis = "vertical" | "horizontal";

export interface ResizerOptions {
  axis: ResizeAxis;
  min: number;
  max: number;
  /** Drag-left-to-grow instead of drag-right-to-grow (editor's right-docked panel). */
  invert?: boolean;
  onResize?: (size: number) => void;
  onEnd?: () => void;
}

type PointerLikeEvent = PointerEvent | MouseEvent | TouchEvent;

function coord(e: PointerLikeEvent, axis: ResizeAxis): number {
  if ("touches" in e && e.touches.length > 0) {
    const touch = e.touches[0];
    return touch ? (axis === "vertical" ? touch.clientY : touch.clientX) : 0;
  }
  if ("clientX" in e) {
    return axis === "vertical" ? e.clientY : e.clientX;
  }
  return 0;
}

export function initResizer(handle: HTMLElement, target: HTMLElement, options: ResizerOptions): void {
  const { axis, min, max, invert = false, onResize, onEnd } = options;
  let isResizing = false;
  let start = 0;
  let startSize = 0;

  const currentSize = (): number => (axis === "vertical" ? target.offsetHeight : target.offsetWidth);
  const applySize = (size: number): void => {
    if (axis === "vertical") {
      target.style.height = `${size}px`;
      target.style.minHeight = `${size}px`;
    } else {
      target.style.width = `${size}px`;
    }
  };

  const onStart = (e: PointerLikeEvent): void => {
    isResizing = true;
    start = coord(e, axis);
    startSize = currentSize();
    handle.classList.add("resizing");
    if ("pointerId" in e && handle.setPointerCapture) {
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // pointer capture is best-effort
      }
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "vertical" ? "row-resize" : "col-resize";
    if (e.cancelable) e.preventDefault();
  };

  const onMove = (e: PointerLikeEvent): void => {
    if (!isResizing) return;
    const delta = coord(e, axis) - start;
    const signedDelta = invert ? -delta : delta;
    const newSize = Math.max(min, Math.min(max, startSize + signedDelta));
    applySize(newSize);
    onResize?.(newSize);
    if (e.cancelable) e.preventDefault();
  };

  const onEndInternal = (e: PointerLikeEvent): void => {
    if (!isResizing) return;
    isResizing = false;
    handle.classList.remove("resizing");
    if ("pointerId" in e && handle.releasePointerCapture) {
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        // pointer capture is best-effort
      }
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    onEnd?.();
  };

  handle.addEventListener("pointerdown", onStart);
  handle.addEventListener("mousedown", onStart);
  handle.addEventListener("touchstart", onStart, { passive: false });

  window.addEventListener("pointermove", onMove);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });

  window.addEventListener("pointerup", onEndInternal);
  window.addEventListener("mouseup", onEndInternal);
  window.addEventListener("touchend", onEndInternal);
  window.addEventListener("pointercancel", onEndInternal);
  window.addEventListener("touchcancel", onEndInternal);
}
