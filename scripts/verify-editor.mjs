/**
 * Browser check for the ported editor.
 *
 * The port's real risk is not "does the page load" but the element-templates
 * properties panel: the Operaton fork ships rollup output importing
 * @bpmn-io/properties-panel and preact as bare specifiers, and if those resolve
 * to a second copy the panel throws inside `useService` the moment a templated
 * element is selected. That only shows up in a browser, so this drives one.
 *
 * Usage: node scripts/verify-editor.mjs [workspaceDir]
 */
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), "graph-agent-verify-"));
mkdirSync(join(root, ".agents", "workflows"), { recursive: true });

// Drive the real CLI rather than importing the server, so this exercises the
// same path a user gets from `graph-agent studio`.
const cli = spawn(process.execPath, [join(import.meta.dirname, "..", "dist", "graph-agent.js"), "studio", "--port", "0"], {
  cwd: root,
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

  await page.goto(`${studio.url}/editor`, { waitUntil: "domcontentloaded" });

  // 1. the modeler mounted and imported the blank diagram
  await page.waitForSelector("#modeler .djs-container svg", { timeout: 20000 });
  const shapes = await page.locator("#modeler .djs-element").count();
  if (shapes < 3) failures.push(`expected the blank diagram's elements, saw ${shapes}`);

  // 2. element templates reached the modeler
  const templateCount = await page.evaluate(async () => {
    const res = await fetch("/api/element-templates");
    return (await res.json()).length;
  });
  if (templateCount < 1) failures.push("no element templates served");

  // 3. selecting the templated service task renders the properties panel.
  //    This is the step that crashes when two preact copies are bundled.
  await page.evaluate(() => {
    const modeler = window.__modeler;
    const registry = modeler.get("elementRegistry");
    const selection = modeler.get("selection");
    selection.select(registry.get("ServiceTask_1"));
  });
  await page.waitForSelector(".bio-properties-panel", { timeout: 20000 });
  const groups = await page.locator(".bio-properties-panel-group").count();
  if (groups < 1) failures.push(`properties panel rendered no groups (${groups})`);

  // 4. applying a template must not throw
  await page.evaluate(() => {
    const modeler = window.__modeler;
    const registry = modeler.get("elementRegistry");
    const templates = modeler.get("elementTemplates");
    const all = templates.getAll();
    const piTemplate = all.find((t) => t.id === "playground.pi-agent-task");
    if (piTemplate) templates.applyTemplate(registry.get("ServiceTask_1"), piTemplate);
  });
  await page.waitForTimeout(500);

  const useServiceCrash = consoleErrors.filter((e) => /useService|context|preact/i.test(e));
  if (useServiceCrash.length) failures.push(`properties-panel errors: ${useServiceCrash.join(" | ")}`);
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
console.log("\nOK  editor renders, templates load, properties panel survives selection + apply");
