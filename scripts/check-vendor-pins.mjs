#!/usr/bin/env node
/**
 * The vendored Operaton element-template packages are pinned twice: as git
 * submodules (for a plain `make setup` checkout) and as flake inputs (because
 * `nix run .` does not fetch submodules). Nothing in git or Nix keeps those two
 * pinnings in step, so this check does.
 *
 * Compares, per vendor package:
 *   - the gitlink recorded in the index for vendor/<name>
 *   - the `rev=` pinned on the corresponding flake input in flake.nix
 *   - the locked rev in flake.lock, when it exists
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const VENDOR = [
  "operaton-element-templates",
  "operaton-element-templates-validator",
  "operaton-element-templates-json-schema",
];

function gitlinks() {
  const out = execFileSync("git", ["ls-files", "-s", "vendor/"], { encoding: "utf8" });
  const map = new Map();
  for (const line of out.split("\n")) {
    const m = /^160000 ([0-9a-f]{40}) \d+\t(.+)$/.exec(line.trim());
    if (m) map.set(m[2].replace(/^vendor\//, ""), m[1]);
  }
  return map;
}

function flakeRevs() {
  const nix = readFileSync("flake.nix", "utf8");
  const map = new Map();
  for (const name of VENDOR) {
    const re = new RegExp(`${name}\\.git\\?rev=([0-9a-f]{40})`);
    const m = re.exec(nix);
    if (m) map.set(name, m[1]);
  }
  return map;
}

function lockRevs() {
  if (!existsSync("flake.lock")) return null;
  const lock = JSON.parse(readFileSync("flake.lock", "utf8"));
  const map = new Map();
  for (const [name, node] of Object.entries(lock.nodes ?? {})) {
    if (VENDOR.includes(name) && node.locked?.rev) map.set(name, node.locked.rev);
  }
  return map;
}

const links = gitlinks();
const flake = flakeRevs();
const lock = lockRevs();

let failed = false;
for (const name of VENDOR) {
  const g = links.get(name);
  const f = flake.get(name);
  const l = lock?.get(name);

  if (!g) { console.error(`FAIL ${name}: no gitlink in the index for vendor/${name}`); failed = true; continue; }
  if (!f) { console.error(`FAIL ${name}: no rev= pinned on the flake input`); failed = true; continue; }
  if (g !== f) {
    console.error(`FAIL ${name}: submodule ${g} != flake.nix ${f}`);
    failed = true;
    continue;
  }
  if (l && l !== g) {
    console.error(`FAIL ${name}: flake.lock ${l} != ${g} -- run \`nix flake update ${name}\``);
    failed = true;
    continue;
  }
  console.log(`ok   ${name} ${g}${l ? "" : "  (flake.lock absent; run `nix flake lock`)"}`);
}

if (failed) {
  console.error("\nvendor pins disagree; submodule and flake input must reference the same commit");
  process.exit(1);
}
