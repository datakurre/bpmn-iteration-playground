/**
 * Where graph-agent keeps things.
 *
 * Graphs are worth sharing between projects -- a loop that works well on one
 * codebase works well on the next -- so the graph library and configuration are
 * user-level, under XDG_CONFIG_HOME. Sessions are machine state, not something
 * you would commit or hand to a colleague, so they live under XDG_STATE_HOME and
 * each one records the project it ran against.
 *
 *   $XDG_CONFIG_HOME/graph-agent/        (default ~/.config/graph-agent)
 *     config.toml
 *     workflows/*.bpmn                   shared graph library
 *
 *   $XDG_STATE_HOME/graph-agent/         (default ~/.local/state/graph-agent)
 *     sessions/<id>/                     one directory per session
 *     logs/
 *
 * A project contributes only its identity: the directory the agent runs in.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = "graph-agent";

export interface Paths {
  /** User-level configuration and the shared graph library. */
  configDir: string;
  workflowsDir: string;
  configFile: string;
  /** User-level state: sessions and logs. */
  stateDir: string;
  sessionsDir: string;
  logsDir: string;
}

export function xdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

export function xdgStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configDir = join(xdgConfigHome(env), APP);
  const stateDir = join(xdgStateHome(env), APP);
  return {
    configDir,
    workflowsDir: join(configDir, "workflows"),
    configFile: join(configDir, "config.toml"),
    stateDir,
    sessionsDir: join(stateDir, "sessions"),
    logsDir: join(stateDir, "logs"),
  };
}

export function ensurePaths(p: Paths): Paths {
  for (const dir of [p.configDir, p.workflowsDir, p.stateDir, p.sessionsDir, p.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

export function isInitialized(p: Paths): boolean {
  return existsSync(p.workflowsDir);
}

/**
 * The project a session belongs to: the directory the agent was started in,
 * resolved through symlinks so two spellings of the same checkout agree.
 */
export function projectId(cwd: string = process.cwd()): string {
  try {
    return realpathSync(resolve(cwd));
  } catch {
    return resolve(cwd);
  }
}

/** Short, human-facing name for a project directory. */
export function projectName(id: string): string {
  return id.split("/").filter(Boolean).pop() ?? id;
}

/**
 * Package root, so the CLI can find `static/`, `workflows/` and
 * `element_templates/` whether it runs from a checkout or a Nix store path.
 */
export function packageRoot(): string {
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
