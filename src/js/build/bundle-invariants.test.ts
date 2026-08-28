// @vitest-environment node
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";

/**
 * Regression guard for the subtlest hazard in the editor build.
 *
 * The vendored Operaton forks ship rollup output that imports
 * bpmn-js-properties-panel / @bpmn-io/properties-panel (and transitively preact)
 * as unresolved bare specifiers. Without the alias map in scripts/build-assets.mjs,
 * esbuild resolves those by walking up from the vendored dist file and finds each
 * submodule's *own* npm install -- producing a second copy of preact's
 * createContext/hooks state alongside the one bpmn-js-properties-panel itself uses.
 * Two Preact instances means the properties panel's context provider and consumer
 * come from different singletons, and `useService` crashes reading `.context` off a
 * component the other copy never rendered.
 *
 * `vendor/operaton-element-templates/node_modules/preact` really does exist on disk,
 * so this is not hypothetical -- the alias map is the only thing keeping it out.
 */
// The two aliases that make the vendored forks resolvable at all. Upstream
// bpmn-js-element-templates is not installed; these are how the fork gets in.
const entryAlias = {
  "bpmn-js-element-templates": resolve("vendor/operaton-element-templates/dist/index.esm.js"),
  "@bpmn-io/element-templates-validator": resolve("vendor/operaton-element-templates-validator/dist/index.js"),
};

// The defensive half: forces every package the vendored dists import as a bare
// specifier back onto this project's own installs.
const dedupeAlias = {
  "bpmn-js-properties-panel": resolve("node_modules/bpmn-js-properties-panel"),
  "@bpmn-io/properties-panel": resolve("node_modules/@bpmn-io/properties-panel"),
  "bpmn-js": resolve("node_modules/bpmn-js"),
  "diagram-js": resolve("node_modules/diagram-js"),
};

const alias = { ...entryAlias, ...dedupeAlias };

async function modelerInputs(dedupe: boolean): Promise<string[]> {
  const result = await build({
    entryPoints: ["src/js/modeler-bundle.ts"],
    bundle: true,
    minify: true,
    format: "iife",
    write: false,
    outfile: "modeler.js",
    loader: { ".json": "json" },
    metafile: true,
    alias: dedupe ? alias : entryAlias,
  });
  return Object.keys(result.metafile.inputs);
}

function preactRoots(inputs: string[]): string[] {
  const roots = new Set<string>();
  for (const file of inputs) {
    const i = file.indexOf("preact/");
    if (i !== -1) roots.add(file.slice(0, i + "preact".length));
  }
  return [...roots].sort();
}

describe("modeler bundle", () => {
  it("pulls no preact or properties-panel copy out of a vendored submodule", async () => {
    const inputs = await modelerInputs(true);
    const leaked = inputs.filter(
      (f) => f.startsWith("vendor/") && /node_modules\/(preact|@bpmn-io\/properties-panel|bpmn-js-properties-panel)\//.test(f),
    );
    expect(leaked).toEqual([]);
  }, 180_000);

  it("resolves every preact copy to this project's own node_modules", async () => {
    const roots = preactRoots(await modelerInputs(true));
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect(root.startsWith("node_modules/")).toBe(true);
  }, 180_000);

  it("would leak a second preact without the alias map", async () => {
    // Proves the guards above are actually testing something: keep only the
    // aliases that make the fork resolvable, drop the deduplicating ones, and the
    // vendored submodule's own installs walk straight into the bundle.
    const leaked = (await modelerInputs(false)).filter(
      (f) => f.startsWith("vendor/") && /node_modules\/(preact|@bpmn-io\/properties-panel)\//.test(f),
    );
    expect(leaked.length).toBeGreaterThan(0);
  }, 180_000);
});
