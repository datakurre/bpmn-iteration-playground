import { parseArgs } from "node:util";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStudio } from "../studio/server.ts";
import { listSessions, SessionStore } from "../agent/session-store.ts";
import {
  bundledWorkflowsDir,
  ensurePaths,
  listBpmnFiles,
  isInitialized,
  paths as resolvePaths,
  projectId,
  projectName,
  type Paths,
} from "../agent/paths.ts";

const USAGE = `graph-agent - a Pi coding agent whose control flow is a BPMN graph

Usage
  graph-agent <command> [options]

Commands
  init                 create the user-level config and graph library
  run [prompt]         start a session in this project and drive it turn by turn
  resume <session>     recover engine + transcript state and continue
  ls                   list this project's sessions (--all for every project)
  show <session>       print a session's turns and current graph revision
  studio               serve the studio for this project
  where                print the config, graph library and state directories

Graphs live in your user config directory and are shared across projects.
Sessions live in your user state directory and record the project they ran in.

Options
  --port <n>           studio port (0 picks a free one)
  --all                with ls, include sessions from other projects
  -h, --help           show this help
  -v, --version        show the version
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
    case "where":
      return cmdWhere();
    case "studio":
      return cmdStudio(argv.slice(1));
    case "ls":
      return cmdLs(argv.includes("--all"));
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

function requirePaths(): Paths | null {
  const p = resolvePaths();
  if (!isInitialized(p)) {
    process.stderr.write("graph-agent: not set up yet. Run `graph-agent init` first.\n");
    return null;
  }
  return p;
}

function cmdInit(): number {
  const p = ensurePaths(resolvePaths());

  // Seed the library with the bundled graphs, but never overwrite a graph the
  // user has since edited -- the library is theirs, and it is shared by every
  // project, so a re-init in a new checkout must not clobber it.
  for (const { id, path: from } of listBpmnFiles(bundledWorkflowsDir())) {
    const to = join(p.workflowsDir, `${id}.bpmn`);
    if (!existsSync(to)) copyFileSync(from, to);
  }

  if (!existsSync(p.configFile)) {
    writeFileSync(
      p.configFile,
      [
        "# graph-agent settings, shared across every project",
        "",
        "[agent]",
        '# model = "anthropic/claude-sonnet-4-5"',
        "",
      ].join("\n"),
    );
  }

  process.stdout.write(`graphs   ${p.workflowsDir}\nsessions ${p.sessionsDir}\nconfig   ${p.configFile}\n`);
  return 0;
}

function cmdWhere(): number {
  const p = resolvePaths();
  process.stdout.write(`config   ${p.configDir}\ngraphs   ${p.workflowsDir}\nstate    ${p.stateDir}\nsessions ${p.sessionsDir}\nproject  ${projectId()}\n`);
  return 0;
}

async function cmdStudio(args: string[]): Promise<number> {
  const p = requirePaths();
  if (!p) return 1;
  const project = projectId();

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
    paths: p,
    project,
    ...(values.host === undefined ? {} : { host: String(values.host) }),
    ...(values.port === undefined ? {} : { port: Number(values.port) }),
  });

  process.stdout.write(`graph-agent studio  ${studio.url}\n`);
  process.stdout.write(`  project   ${projectName(project)}  ${project}\n`);
  process.stdout.write(`  sessions  ${studio.url}/\n`);
  process.stdout.write(`  graphs    ${studio.url}/graph\n`);

  await new Promise<void>((done) => {
    const stop = (): void => {
      void studio.close().then(done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function cmdLs(all: boolean): number {
  const p = requirePaths();
  if (!p) return 1;
  const sessions = listSessions(p, all ? undefined : projectId());
  if (sessions.length === 0) {
    process.stdout.write(all ? "no sessions yet\n" : "no sessions in this project yet\n");
    return 0;
  }
  for (const store of sessions) {
    const s = store.summary();
    const where = all ? `  ${projectName(s.project)}` : "";
    process.stdout.write(
      `${s.id}  ${s.status.padEnd(9)}  ${String(s.turnCount).padStart(3)} turns${where}  ${s.name ?? ""}\n`,
    );
  }
  return 0;
}

function cmdShow(id: string | undefined): number {
  const p = requirePaths();
  if (!p) return 1;
  if (!id) {
    process.stderr.write("graph-agent: show requires a session id\n");
    return 2;
  }
  const store = new SessionStore(p, id);
  if (!store.exists()) {
    process.stderr.write(`graph-agent: unknown session '${id}'\n`);
    return 1;
  }
  const detail = store.detail();
  process.stdout.write(`${detail.id}  ${detail.status}  ${detail.turnCount} turns\n`);
  process.stdout.write(`project: ${detail.project}\n`);
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
