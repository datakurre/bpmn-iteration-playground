import { build } from "esbuild";
import { readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const common = { bundle: true, minify: true, format: "iife" };

// The modeler bundle doesn't import `bpmn-js-element-templates` yet, but when it
// does, this resolves it (and its own `@bpmn-io/element-templates-validator`
// dependency) to the vendored Operaton/Camunda 7 forks under vendor/ instead of
// the upstream npm packages (which aren't even installed). Mirrors the Vite
// `resolve.alias` used by vendor/operaton-element-templates's own reference
// integration. Run `make vendor-build` first to produce these dist/ files.
const elementTemplatesAlias = {
  "bpmn-js-element-templates": resolve("vendor/operaton-element-templates/dist/index.esm.js"),
  "@bpmn-io/element-templates-validator": resolve("vendor/operaton-element-templates-validator/dist/index.js"),
};

await build({
  ...common,
  entryPoints: ["src/js/viewer-bundle.ts"],
  outfile: "app/static/bpmn-viewer-bundle.js",
});

await build({
  ...common,
  entryPoints: ["src/js/modeler-bundle.ts"],
  outfile: "app/static/bpmn-modeler-bundle.js",
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
    outdir: "app/static/pages",
  });
}

copyFileSync(
  "node_modules/diagram-js-minimap/assets/diagram-js-minimap.css",
  "app/static/diagram-js-minimap.css",
);
copyFileSync(
  "node_modules/@bpmn-io/properties-panel/dist/assets/properties-panel.css",
  "app/static/properties-panel.css",
);
copyFileSync(
  "node_modules/bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css",
  "app/static/bpmn-js-token-simulation.css",
);
copyFileSync(
  "node_modules/bpmn-js-bpmnlint/dist/assets/css/bpmn-js-bpmnlint.css",
  "app/static/bpmn-js-bpmnlint.css",
);
