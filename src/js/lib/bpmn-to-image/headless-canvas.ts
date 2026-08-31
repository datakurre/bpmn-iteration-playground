/**
 * Headless browser environment for bpmn-js.
 *
 * Creates a jsdom instance with all SVG / CSS polyfills required to run the
 * bpmn-js browser bundle outside of a real browser.  The instance is lazily
 * initialised on first call and then reused.
 *
 * Polyfill implementations live in `./headless-polyfills.ts`.
 */

// @ts-expect-error jsdom lacks bundled types in this project
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { applyPolyfills } from './headless-polyfills.ts';

const req = createRequire(import.meta.url);

let jsdomInstance: any;
let BpmnModelerCtor: any;

/** Ensure the jsdom instance + polyfills exist and return the canvas element. */
export function createHeadlessCanvas(): HTMLElement {
  if (!jsdomInstance) {
    const bpmnJsPath = req.resolve('bpmn-js/dist/bpmn-modeler.development.js');
    let bpmnJsBundle = fs.readFileSync(bpmnJsPath, 'utf-8');

    // Patch path-intersection: pathToCurve receives null from parsePathString
    // when given a null/empty path string (headless SVG elements lack renderable
    // path data). Without this guard, isPathCurve(null) crashes with
    // "Cannot read properties of null (reading 'length')".
    bpmnJsBundle = bpmnJsBundle.replace(
      /if \(isPathCurve\(path\)\) \{/,
      'if (!path) return []; if (isPathCurve(path)) {'
    );

    jsdomInstance = new JSDOM("<!DOCTYPE html><html><body><div id='canvas'></div></body></html>", {
      runScripts: 'outside-only',
    });

    applyPolyfills(jsdomInstance);

    // Execute the bpmn-js bundle inside jsdom
    jsdomInstance.window.eval(bpmnJsBundle);

    // Expose globals that bpmn-js expects at runtime
    (global as any).document = jsdomInstance.window.document;
    (global as any).window = jsdomInstance.window;

    BpmnModelerCtor = (jsdomInstance.window as any).BpmnJS;
  }

  const div = jsdomInstance.window.document.createElement('div');
  jsdomInstance.window.document.body.appendChild(div);
  return div;
}

/** Return the lazily-loaded BpmnModeler constructor. */
export function getBpmnModeler(): any {
  if (!BpmnModelerCtor) {
    createHeadlessCanvas(); // triggers lazy init
  }
  return BpmnModelerCtor;
}
