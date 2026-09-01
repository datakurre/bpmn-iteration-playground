import { build } from "esbuild";
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const outDir = mkdtempSync(join(process.cwd(), ".tui-screenshot-"));
const modulePath = join(outDir, "capture.mjs");
const artifacts = join(process.cwd(), "docs", "tui");
mkdirSync(artifacts, { recursive: true });

try {
  await build({ entryPoints: ["src/tui/capture.ts"], outfile: modulePath, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external" });
  const { captureTui } = await import(modulePath);
  const result = await captureTui();
  writeFileSync(join(artifacts, "showcase.txt"), result.screen + "\n");
  writeFileSync(join(artifacts, "showcase.ansi"), result.ansi);

  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 960, height: 520 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:#111827}pre{box-sizing:border-box;margin:0;padding:18px;color:#e5e7eb;background:#111827;font:14px/1.45 "DejaVu Sans Mono",monospace;white-space:pre;}</style><pre>${escapeHtml(result.screen)}</pre>`);
  await page.screenshot({ path: join(artifacts, "showcase.png") });
  await browser.close();
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync("/opt/pw-browsers/chromium")) return "/opt/pw-browsers/chromium";
  for (const command of ["chromium", "google-chrome"]) {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  if (existsSync("/nix/store")) {
    for (const entry of readdirSync("/nix/store")) {
      const candidate = join("/nix/store", entry, "bin", "chromium");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "/opt/pw-browsers/chromium";
}
