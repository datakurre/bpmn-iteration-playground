/**
 * Scripted screenshots for docs/.
 *
 * Drives the real CLI the way scripts/verify-editor.mjs does, against a
 * throwaway workspace, so the pictures in docs/ always match what
 * `graph-agent studio` actually renders rather than a hand-maintained mock.
 *
 * Usage: node scripts/screenshot-docs.mjs [outDir]
 */
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync("/opt/pw-browsers/chromium")) return "/opt/pw-browsers/chromium";
  const which = spawnSync("which", ["chromium"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() && existsSync(which.stdout.trim())) return which.stdout.trim();
  const whichChrome = spawnSync("which", ["google-chrome"], { encoding: "utf8" });
  if (whichChrome.status === 0 && whichChrome.stdout.trim() && existsSync(whichChrome.stdout.trim())) return whichChrome.stdout.trim();
  if (existsSync("/nix/store")) {
    try {
      const entries = readdirSync("/nix/store");
      for (const e of entries) {
        if (e.includes("profile") || e.includes("chromium")) {
          const candidate = join("/nix/store", e, "bin", "chromium");
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }
  return "/opt/pw-browsers/chromium";
}

const outDir = process.argv[2] ?? join(import.meta.dirname, "..", "docs", "screenshots");
mkdirSync(outDir, { recursive: true });

// A throwaway XDG home and project directory: the studio scopes sessions to
// the directory it runs in, and screenshots should never touch a real one.
const home = mkdtempSync(join(tmpdir(), "graph-agent-screenshots-"));
const root = mkdtempSync(join(tmpdir(), "graph-agent-screenshots-project-"));
const cliPath = join(import.meta.dirname, "..", "dist", "graph-agent.js");
const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };

function run(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`graph-agent ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

spawnSync("git", ["init"], { cwd: root });
run(["init"]);
const runOutput = run(["run", "verify this workspace", "--dry-run", "--graph", "shell-demo"]);
const sessionId = /^session (\S+)/m.exec(runOutput)?.[1];
if (!sessionId) throw new Error(`could not find a session id in:\n${runOutput}`);

const cli = spawn(process.execPath, [cliPath, "studio", "--port", "0"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "inherit"],
});
const studioUrl = await new Promise((resolveUrl, reject) => {
  const timer = setTimeout(() => reject(new Error("studio did not start within 30s")), 30000);
  let buffered = "";
  cli.stdout.on("data", (chunk) => {
    buffered += chunk.toString();
    const match = /http:\/\/[0-9.]+:\d+/.exec(buffered);
    if (match) {
      clearTimeout(timer);
      resolveUrl(match[0]);
    }
  });
  cli.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`studio exited with ${code}`));
  });
});

const shots = [
  { path: "/", file: "project.png", wait: "#sessions" },
  { path: "/graph?id=shell-demo", file: "graph-shell-demo.png", wait: "#modeler .djs-container svg" },
  { path: "/graph?id=pi-default-loop", file: "graph-pi-default-loop.png", wait: "#modeler .djs-container svg" },
  { path: `/session?id=${sessionId}`, file: "session.png", wait: "#turns" },
];

let browser;
try {
  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  for (const shot of shots) {
    await page.goto(`${studioUrl}${shot.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(shot.wait, { timeout: 20000 });
    await page.waitForTimeout(shot.path.startsWith("/graph") ? 800 : 300); // let the diagram settle
    const dest = join(outDir, shot.file);
    await page.screenshot({ path: dest });
    console.log(`wrote ${dest}`);
  }
} finally {
  await browser?.close();
  cli.kill("SIGTERM");
}
