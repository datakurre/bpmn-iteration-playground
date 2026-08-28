import { build } from "esbuild";
import { readdirSync, copyFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const common = { bundle: true, minify: true, format: "iife" };

await build({
  ...common,
  entryPoints: ["src/js/viewer-bundle.ts"],
  outfile: "static/bpmn-viewer-bundle.js",
});

await build({
  ...common,
  entryPoints: ["src/js/modeler-bundle.ts"],
  outfile: "static/bpmn-modeler-bundle.js",
  loader: { ".json": "json" },
});

const pagesDir = "src/studio/pages";
const pageEntries = readdirSync(pagesDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(pagesDir, f));

// The studio serves its HTML from static/pages too, so the whole browser-facing
// surface lives under one directory that packaging can copy wholesale.
mkdirSync("static/pages", { recursive: true });
for (const page of readdirSync(pagesDir).filter((f) => f.endsWith(".html"))) {
  copyFileSync(join(pagesDir, page), join("static/pages", page));
}

if (pageEntries.length > 0) {
  await build({
    ...common,
    entryPoints: pageEntries,
    outdir: "static/pages",
  });
}

copyFileSync(
  "node_modules/diagram-js-minimap/assets/diagram-js-minimap.css",
  "static/diagram-js-minimap.css",
);
copyFileSync(
  "node_modules/@bpmn-io/properties-panel/dist/assets/properties-panel.css",
  "static/properties-panel.css",
);
copyFileSync(
  "node_modules/bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css",
  "static/bpmn-js-token-simulation.css",
);
copyFileSync(
  "node_modules/bpmn-js-bpmnlint/dist/assets/css/bpmn-js-bpmnlint.css",
  "static/bpmn-js-bpmnlint.css",
);
copyFileSync(
  "node_modules/@bpmn-io/element-template-chooser/dist/element-template-chooser.css",
  "static/element-template-chooser.css",
);

// Copy standalone vendor distribution assets for self-contained packaging
mkdirSync("static/vendor/bpmn-js", { recursive: true });
cpSync("node_modules/bpmn-js/dist/assets", "static/vendor/bpmn-js/assets", { recursive: true });

mkdirSync("static/vendor/form-js/assets", { recursive: true });
cpSync("node_modules/@bpmn-io/form-js/dist/assets", "static/vendor/form-js/assets", { recursive: true });
copyFileSync("node_modules/@bpmn-io/form-js/dist/form-viewer.umd.js", "static/vendor/form-js/form-viewer.umd.js");

