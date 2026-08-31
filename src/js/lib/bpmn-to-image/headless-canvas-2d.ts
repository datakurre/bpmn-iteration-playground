/**
 * Headless Canvas 2D text-metrics polyfill.
 *
 * bpmn-js (since ~18.9) measures label text via
 * `document.createElement('canvas').getContext('2d').measureText(...)`
 * instead of the SVG `getComputedTextLength` API (see `./headless-bbox.ts`
 * for that older code path, still used elsewhere by diagram-js).
 *
 * jsdom does not implement `HTMLCanvasElement#getContext` unless the native
 * `canvas` package is installed. Without a polyfill, `getContext('2d')`
 * returns `null`, so bpmn-js's `getTextBBox()` falls back to `{ width: 0,
 * height: 0 }` for every label. Its text-wrapping loop
 * (`layoutNext` in diagram-js's `Text` util) assumes a real measurement and
 * shrinks the candidate line based on `maxWidth / width`; with `width`
 * pinned at `0` that ratio is `Infinity`, so the "shortened" line comes back
 * unchanged and the loop never terminates.
 *
 * This polyfill provides a minimal `CanvasRenderingContext2D` stand-in that
 * answers `measureText()` using the same proportional Arial metrics table
 * used by the SVG `getBBox`/`getComputedTextLength` polyfills, so the
 * upstream wrapping loop converges exactly as it would in a real browser.
 */

import { measureTextWidth } from './headless-bbox';

interface FakeTextMetrics {
  width: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
}

interface FakeCanvasContext2D {
  font: string;
  fillStyle: string;
  letterSpacing: string;
  measureText(text: string): FakeTextMetrics;
}

/** Extract the pixel font size from a CSS font shorthand string (e.g. "bold 12px Arial"). */
function parseFontSizePx(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match && match[1] ? parseFloat(match[1]) : 12;
}

function createCanvasContext2D(): FakeCanvasContext2D {
  return {
    font: '10px sans-serif',
    fillStyle: '#000000',
    letterSpacing: '0px',
    measureText(text: string): FakeTextMetrics {
      const fontSize = parseFontSizePx(this.font);
      const width = measureTextWidth(text, fontSize);
      // Approximate ascent/descent split; bpmn-js only sums the two.
      const ascent = fontSize * 0.8;
      const descent = fontSize * 0.2;
      return {
        width,
        actualBoundingBoxAscent: ascent,
        actualBoundingBoxDescent: descent,
        fontBoundingBoxAscent: ascent,
        fontBoundingBoxDescent: descent,
      };
    },
  };
}

/** Polyfill `HTMLCanvasElement#getContext('2d')` with a text-metrics-only fake context. */
export function applyCanvasPolyfills(win: any): void {
  const HTMLCanvasElement = win.HTMLCanvasElement;
  if (!HTMLCanvasElement) return;

  HTMLCanvasElement.prototype.getContext = function (this: any, type: string) {
    if (type !== '2d') return null;
    if (!this._fakeContext2D) {
      this._fakeContext2D = createCanvasContext2D();
    }
    return this._fakeContext2D;
  };
}
