/**
 * Browser check for the editor.
 *
 * The properties panel is where the Camunda 8 element templates actually get
 * exercised: the Cloud provider has to load the templates, render a group for a
 * selected element, and survive applying one. None of that shows up outside a
 * browser, so this drives one.
 *
 * Usage: node scripts/verify-editor.mjs [workspaceDir]
 */
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A throwaway XDG home, so verification never touches the real graph library.
const home = mkdtempSync(join(tmpdir(), "graph-agent-verify-"));
const root = process.argv[2] ?? home;
mkdirSync(root, { recursive: true });
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_STATE_HOME: join(home, "state"),
};
spawnSync(process.execPath, [join(import.meta.dirname, "..", "dist", "graph-agent.js"), "init"], { cwd: root, env, stdio: "ignore" });

// Drive the real CLI rather than importing the server, so this exercises the
// same path a user gets from `graph-agent studio`.
const cli = spawn(process.execPath, [join(import.meta.dirname, "..", "dist", "graph-agent.js"), "studio", "--port", "0"], {
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
    if (match) { clearTimeout(timer); resolveUrl(match[0]); }
  });
  cli.once("exit", (code) => { clearTimeout(timer); reject(new Error(`studio exited with ${code}`)); });
});
const studio = { url: studioUrl, close: async () => { cli.kill("SIGTERM"); } };
const failures = [];
const consoleErrors = [];
const missingResources = [];
let browser;

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400) missingResources.push(`${res.status()} ${res.url()}`);
  });

  await page.goto(`${studio.url}/graph`, { waitUntil: "domcontentloaded" });

  // 1. the modeler mounted and imported a diagram
  await page.waitForSelector("#modeler .djs-container svg", { timeout: 20000 });
  const shapes = await page.locator("#modeler .djs-element").count();
  if (shapes < 3) failures.push(`expected a diagram's elements, saw ${shapes}`);

  // 2. the page knows which project it is scoped to
  const projectName = (await page.locator("#project-name").textContent())?.trim();
  if (!projectName || projectName === "\u2026") failures.push("the header never resolved the project");

  // 3. element templates reached the modeler
  const templateCount = await page.evaluate(async () => {
    const res = await fetch("/api/element-templates");
    return (await res.json()).length;
  });
  if (templateCount < 1) failures.push("no element templates served");

  // 4. selecting a templated service task renders the properties panel
  await page.evaluate(() => {
    const modeler = window.__modeler;
    const registry = modeler.get("elementRegistry");
    const selection = modeler.get("selection");
    selection.select(registry.get("turn"));
  });
  await page.waitForSelector(".bio-properties-panel", { timeout: 20000 });
  const groups = await page.locator(".bio-properties-panel-group").count();
  if (groups < 1) failures.push(`properties panel rendered no groups (${groups})`);

  // 5. applying a template must not throw
  const applied = await page.evaluate(() => {
    const modeler = window.__modeler;
    const registry = modeler.get("elementRegistry");
    const templates = modeler.get("elementTemplates");
    const piTemplate = templates.getAll().find((t) => t.id === "graph-agent.pi-agent-turn");
    if (!piTemplate) return null;
    templates.applyTemplate(registry.get("turn"), piTemplate);
    const bo = registry.get("turn").businessObject;
    const values = bo.extensionElements?.values ?? [];
    return {
      template: bo.get("zeebe:modelerTemplate"),
      jobType: values.find((v) => v.$type === "zeebe:TaskDefinition")?.type,
    };
  });
  if (!applied) failures.push("the Pi Agent Turn template was not loaded by the modeler");
  else {
    if (applied.template !== "graph-agent.pi-agent-turn")
      failures.push(`zeebe:modelerTemplate not set (got ${applied.template})`);
    if (applied.jobType !== "agent:turn")
      failures.push(`applying the template did not bind zeebe:taskDefinition type (got ${applied.jobType})`);
  }
  await page.waitForTimeout(500);

  // Anything the panel throws while rendering a templated element.
  if (consoleErrors.length) failures.push(`console errors: ${consoleErrors.join(" | ")}`);
  if (missingResources.length) failures.push(`unresolved resources: ${missingResources.join(" | ")}`);
} catch (error) {
  failures.push(`threw: ${error.message}`);
} finally {
  await browser?.close();
  await studio.close();
}

if (missingResources.length) {
  console.log("non-2xx responses:");
  for (const r of missingResources) console.log("  ", r);
}
if (consoleErrors.length) {
  console.log("console errors seen:");
  for (const e of consoleErrors) console.log("  ", e);
}
if (failures.length) {
  console.error("\nFAIL");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nOK  editor renders, Camunda 8 templates load, properties panel renders and applies one");
