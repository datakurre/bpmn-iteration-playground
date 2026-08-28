import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS_DIR = ".agents";

export interface Workspace {
  /** Project root: the directory containing `.agents/`. */
  root: string;
  /** `<root>/.agents` */
  agentsDir: string;
  /** Editable BPMN graphs. Meant to be committed with the project. */
  workflowsDir: string;
  /** One directory per session. */
  sessionsDir: string;
  logsDir: string;
}

/**
 * Walk up from `start` looking for an existing `.agents/`. Falls back to `start`
 * so `init` has somewhere to create one.
 */
export function findWorkspace(start: string = process.cwd()): Workspace {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, AGENTS_DIR))) return workspaceAt(dir);
    const parent = dirname(dir);
    if (parent === dir) return workspaceAt(resolve(start));
    dir = parent;
  }
}

export function workspaceAt(root: string): Workspace {
  const agentsDir = join(root, AGENTS_DIR);
  return {
    root,
    agentsDir,
    workflowsDir: join(agentsDir, "workflows"),
    sessionsDir: join(agentsDir, "sessions"),
    logsDir: join(agentsDir, "logs"),
  };
}

export function ensureWorkspace(workspace: Workspace): Workspace {
  for (const dir of [workspace.agentsDir, workspace.workflowsDir, workspace.sessionsDir, workspace.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return workspace;
}

export function isInitialized(workspace: Workspace): boolean {
  return existsSync(workspace.agentsDir);
}

/**
 * Package root, so the CLI can find `static/`, `workflows/` and
 * `element_templates/` whether it runs from a checkout or from a Nix store path.
 */
export function packageRoot(): string {
  // dist/graph-agent.js and src/agent/workspace.ts are both one or two levels
  // below the package root; walk up until package.json shows up.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export function bundledWorkflowsDir(): string {
  return join(packageRoot(), "workflows");
}

export function staticDir(): string {
  return join(packageRoot(), "static");
}

export function elementTemplatesDir(): string {
  return join(packageRoot(), "element_templates");
}

/** `.bpmn` files in a directory, as `{ id, path }` with id = basename without extension. */
export function listBpmnFiles(dir: string): Array<{ id: string; path: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".bpmn"))
    .sort()
    .map((f) => ({ id: f.replace(/\.bpmn$/, ""), path: join(dir, f) }));
}
