import { parseArgs } from "node:util";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStudio } from "../studio/server.ts";
import { listSessions, SessionStore } from "../agent/session-store.ts";
import {
  bundledWorkflowsDir,
  ensureWorkspace,
  findWorkspace,
  isInitialized,
  workspaceAt,
  type Workspace,
} from "../agent/workspace.ts";

const USAGE = `graph-agent - a Pi coding agent driven by mutable Camunda-7-flavour BPMN graphs

Usage
  graph-agent <command> [options]

Commands
  init                     scaffold .agents/ in the current directory
  run [prompt]             start a session and drive it turn by turn
  resume <session>         recover engine + transcript state and continue
  ls                       list sessions
  show <session>           print a session's turns and current graph revision
  studio [workflow.bpmn]   serve the BPMN studio (visualise sessions, edit graphs)
  lint [file...]           lint workflow graphs
  layout <file>            auto-layout a graph in place

Options
  --port <n>               studio port (0 picks a free one)
  --no-open                do not open a browser
  -h, --help               show this help
  -v, --version            show the version
`;

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit();
    case "studio":
      return cmdStudio(argv.slice(1));
    case "ls":
      return cmdLs();
    case "show":
      return cmdShow(argv[1]);
    case "run":
    case "resume":
    case "lint":
    case "layout":
      process.stderr.write(`graph-agent: '${command}' is not wired up yet\n`);
      return 2;
    default:
      process.stderr.write(`graph-agent: unknown command '${command}'\n\n${USAGE}`);
      return 2;
  }
}

function version(): string {
  return "0.1.0";
}

function requireWorkspace(): Workspace | null {
  const workspace = findWorkspace();
  if (!isInitialized(workspace)) {
    process.stderr.write("graph-agent: no .agents/ found. Run `graph-agent init` first.\n");
    return null;
  }
  return workspace;
}

function cmdInit(): number {
  const workspace = ensureWorkspace(workspaceAt(process.cwd()));

  // Seed the workspace with the bundled loop library so a fresh project has the
  // default Pi loop, the session skeleton and the crafting graph to hand.
  const bundled = bundledWorkflowsDir();
  if (existsSync(bundled)) cpSync(bundled, workspace.workflowsDir, { recursive: true });

  const gitignore = join(workspace.agentsDir, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(
      gitignore,
      [
        "# machine state; workflows/ and config.toml are meant to be committed",
        "sessions/",
        "logs/",
        "runtime.json",
        "",
      ].join("\n"),
    );
  }

  const config = join(workspace.agentsDir, "config.toml");
  if (!existsSync(config)) {
    writeFileSync(config, ['# graph-agent workspace settings', '', '[agent]', '# model = "anthropic/claude-sonnet-4-5"', ""].join("\n"));
  }

  process.stdout.write(`initialized ${workspace.agentsDir}\n`);
  return 0;
}

async function cmdStudio(args: string[]): Promise<number> {
  const workspace = requireWorkspace();
  if (!workspace) return 1;

  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      open: { type: "boolean", default: true },
    },
    allowPositionals: true,
    strict: false,
  });

  const studio = await startStudio({
    workspace,
    ...(values.host === undefined ? {} : { host: String(values.host) }),
    ...(values.port === undefined ? {} : { port: Number(values.port) }),
  });

  process.stdout.write(`graph-agent studio  ${studio.url}\n`);
  process.stdout.write(`  sessions  ${studio.url}/\n`);
  process.stdout.write(`  editor    ${studio.url}/editor\n`);

  await new Promise<void>((done) => {
    const stop = (): void => {
      void studio.close().then(done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function cmdLs(): number {
  const workspace = requireWorkspace();
  if (!workspace) return 1;
  const sessions = listSessions(workspace);
  if (sessions.length === 0) {
    process.stdout.write("no sessions yet\n");
    return 0;
  }
  for (const store of sessions) {
    const s = store.summary();
    process.stdout.write(
      `${s.id}  ${s.status.padEnd(9)}  ${String(s.turnCount).padStart(3)} turns  ${s.name ?? ""}\n`,
    );
  }
  return 0;
}

function cmdShow(id: string | undefined): number {
  const workspace = requireWorkspace();
  if (!workspace) return 1;
  if (!id) {
    process.stderr.write("graph-agent: show requires a session id\n");
    return 2;
  }
  const store = new SessionStore(workspace, id);
  if (!store.exists()) {
    process.stderr.write(`graph-agent: unknown session '${id}'\n`);
    return 1;
  }
  const detail = store.detail();
  process.stdout.write(`${detail.id}  ${detail.status}  ${detail.turnCount} turns\n`);
  process.stdout.write(`tokens: ${detail.tokens.join(", ") || "-"}\n`);
  process.stdout.write(`graph revisions: ${detail.revisions.length}\n\n`);
  for (const turn of detail.turns) {
    process.stdout.write(
      `${String(turn.index).padStart(3)}  ${turn.activityId}  ${turn.harness ?? ""}  ${turn.stopReason ?? ""}\n`,
    );
  }
  return 0;
}

const exitCode = await main(process.argv.slice(2));
if (exitCode !== 0) process.exitCode = exitCode;
