import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const outDir = mkdtempSync(join(process.cwd(), ".tui-showcase-"));
const outfile = join(outDir, "showcase.mjs");
try {
  await build({ entryPoints: ["src/tui/showcase.ts"], outfile, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external" });
  await import(outfile);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
