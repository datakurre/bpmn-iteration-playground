import { build } from "esbuild";
import { readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const common = { bundle: true, minify: true, format: "iife" };

// Resolves the modeler bundle's `bpmn-js-element-templates` import (and its own
// `@bpmn-io/element-templates-validator` dependency) to the vendored Operaton/
// Camunda 7 forks under vendor/ instead of the upstream npm packages (which
// aren't even installed). Mirrors the Vite `resolve.alias` used by
// vendor/operaton-element-templates's own reference integration. Run
// `make vendor-build` first to produce these dist/ files.
//
// The vendored dist files import bpmn-js-properties-panel/@bpmn-io/properties-panel
// (and transitively preact) as external bare specifiers, left unresolved by their
// own rollup build. Without the extra aliases below, esbuild resolves those bare
// specifiers by walking up from the dist file's own location and finds each
// submodule's *own* `npm install`, not ours -- producing a second, separate copy
// of preact's `createContext`/hooks state alongside the one bpmn-js-properties-panel
// itself uses. Two Preact instances means the properties panel's context provider
// and consumer come from different singletons, and `useService` crashes reading
// `.context` off a component preact's other copy never rendered. Aliasing these
// package roots (esbuild's alias forwards subpaths of a real package directory,
// e.g. `@bpmn-io/properties-panel/preact/hooks`) forces every copy in the bundle
// graph back onto this project's own node_modules installs.
const elementTemplatesAlias = {
  "bpmn-js-element-templates": resolve("vendor/operaton-element-templates/dist/index.esm.js"),
  "@bpmn-io/element-templates-validator": resolve("vendor/operaton-element-templates-validator/dist/index.js"),
  "bpmn-js-properties-panel": resolve("node_modules/bpmn-js-properties-panel"),
  "@bpmn-io/properties-panel": resolve("node_modules/@bpmn-io/properties-panel"),
  "bpmn-js": resolve("node_modules/bpmn-js"),
  "diagram-js": resolve("node_modules/diagram-js"),
};

await build({
  ...common,
  entryPoints: ["src/js/viewer-bundle.ts"],
  outfile: "bpmn_agent/static/bpmn-viewer-bundle.js",
});

await build({
  ...common,
  entryPoints: ["src/js/modeler-bundle.ts"],
  outfile: "bpmn_agent/static/bpmn-modeler-bundle.js",
  loader: { ".json": "json" },
  alias: elementTemplatesAlias,
});

const pagesDir = "src/js/pages";
const pageEntries = readdirSync(pagesDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(pagesDir, f));

if (pageEntries.length > 0) {
  await build({
    ...common,
    entryPoints: pageEntries,
    outdir: "bpmn_agent/static/pages",
  });
}

copyFileSync(
  "node_modules/diagram-js-minimap/assets/diagram-js-minimap.css",
  "bpmn_agent/static/diagram-js-minimap.css",
);
copyFileSync(
  "node_modules/@bpmn-io/properties-panel/dist/assets/properties-panel.css",
  "bpmn_agent/static/properties-panel.css",
);
copyFileSync(
  "node_modules/bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css",
  "bpmn_agent/static/bpmn-js-token-simulation.css",
);
copyFileSync(
  "node_modules/bpmn-js-bpmnlint/dist/assets/css/bpmn-js-bpmnlint.css",
  "bpmn_agent/static/bpmn-js-bpmnlint.css",
);
copyFileSync(
  "node_modules/@bpmn-io/element-template-chooser/dist/element-template-chooser.css",
  "bpmn_agent/static/element-template-chooser.css",
);
