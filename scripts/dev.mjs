import { context } from "esbuild";
import { spawn } from "node:child_process";
import { readdirSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Watches src/ and rebuilds the CLI bundle, the studio's browser bundles and
// the Tailwind stylesheet on change, restarting `graph-agent studio` whenever
// the CLI bundle (which embeds the studio server) is rebuilt. Asset-only
// rebuilds (bundles, CSS, page HTML) do not need a restart -- the studio
// serves them from disk on every request.

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ?? "0";
let studio = null;

function restartStudio() {
  if (studio) studio.kill();
  studio = spawn(
    process.execPath,
    ["dist/graph-agent.js", "studio", "--host", host, "--port", port, "--no-open"],
    {
      stdio: "inherit",
    },
  );
}

function copyPageHtml() {
  rmSync("static/pages", { recursive: true, force: true });
  mkdirSync("static/pages", { recursive: true });
  for (const page of readdirSync("src/studio/pages").filter((f) => f.endsWith(".html"))) {
    copyFileSync(join("src/studio/pages", page), join("static/pages", page));
  }
}

const cliCtx = await context({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/graph-agent.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  plugins: [
    {
      name: "restart-studio",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) restartStudio();
        });
      },
    },
  ],
});

const assetsCommon = { bundle: true, format: "iife" };
const pageEntries = readdirSync("src/studio/pages")
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join("src/studio/pages", f));

copyPageHtml();

const viewerCtx = await context({
  ...assetsCommon,
  entryPoints: ["src/js/viewer-bundle.ts"],
  outfile: "static/bpmn-viewer-bundle.js",
});
const modelerCtx = await context({
  ...assetsCommon,
  entryPoints: ["src/js/modeler-bundle.ts"],
  outfile: "static/bpmn-modeler-bundle.js",
  loader: { ".json": "json" },
});
const pagesCtx =
  pageEntries.length > 0
    ? await context({
        ...assetsCommon,
        entryPoints: pageEntries,
        outdir: "static/pages",
      })
    : null;

await Promise.all([cliCtx.watch(), viewerCtx.watch(), modelerCtx.watch(), pagesCtx?.watch()]);

const tailwind = spawn(
  "npx",
  ["tailwindcss", "-i", "./src/css/styles.css", "-o", "./static/tailwind.css", "--watch"],
  { stdio: "inherit" },
);

process.stdout.write("watching src/ -- rebuilding on change, studio restarts when the CLI bundle changes\n");

async function shutdown() {
  tailwind.kill();
  studio?.kill();
  await Promise.all([cliCtx.dispose(), viewerCtx.dispose(), modelerCtx.dispose(), pagesCtx?.dispose()]);
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
