import { build } from "esbuild";
import { readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const common = { bundle: true, minify: true, format: "iife" };

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
