import { build } from "esbuild";

// node_modules stay external: the CLI pulls in Pi, bpmn-engine and ws, all of
// which ship their own runtime assets and conditional requires that do not
// survive bundling. `buildNpmPackage` installs them alongside dist/ anyway.
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/graph-agent.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
