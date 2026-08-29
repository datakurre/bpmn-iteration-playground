import { parseArgs } from "node:util";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graphPath, startStudio } from "../studio/server.ts";
import { resumeSession, runSession } from "../agent/runner.ts";
import { createPiToolExecutor } from "../agent/tool-executor.ts";
import { dryRunModel, readConfiguredModel, resolveModel } from "./model.ts";
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
                        (--refresh: take the bundled version of any graph
                        that differs from your library copy, backed up first)
  run [prompt]         start a session in this project and drive it turn by turn
  resume <session>     recover engine + transcript state and continue
  ls                   list this project's sessions (--all for every project)
  show <session>       print a session's turns and current graph revision
  studio               serve the studio for this project
  where                print the config, graph library and state directories

Graphs live in your user config directory and are shared across projects.
Sessions live in your user state directory and record the project they ran in.

Options
  --graph <id>         graph to run (default: pi-default-loop)
  --model <spec>       provider/model to use (default: config.toml's [agent]
                        model, or the first model with credentials)
  --dry-run            walk the graph without calling a model
  --name <name>        label the session
  --answer key=value   answer a parked human gate (resume only; repeatable)
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
      return cmdInit(argv.slice(1));
    case "where":
      return cmdWhere();
    case "studio":
      return cmdStudio(argv.slice(1));
    case "ls":
      return cmdLs(argv.includes("--all"));
    case "show":
      return cmdShow(argv[1]);
    case "run":
      return cmdRun(argv.slice(1));
    case "resume":
      return cmdResume(argv.slice(1));
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

function cmdInit(args: string[]): number {
  const p = ensurePaths(resolvePaths());
  const refresh = args.includes("--refresh") || args.includes("--force");

  // Seed the library with the bundled graphs, but never silently overwrite a
  // graph the user has since edited -- the library is theirs, and it is
  // shared by every project, so a re-init in a new checkout must not clobber
  // it. A bundled graph can still be *fixed* upstream after someone's already
  // seeded a copy, though, and nothing said so (issue #35): a stale copy just
  // keeps running its old bug with no warning. So compare content, report a
  // mismatch, and let --refresh take the bundled copy (backed up first).
  const stale: string[] = [];
  const refreshed: string[] = [];
  for (const { id, path: from } of listBpmnFiles(bundledWorkflowsDir())) {
    const to = join(p.workflowsDir, `${id}.bpmn`);
    if (!existsSync(to)) {
      copyFileSync(from, to);
      continue;
    }
    if (readFileSync(from, "utf8") === readFileSync(to, "utf8")) continue;
    if (refresh) {
      copyFileSync(to, `${to}.bak`);
      copyFileSync(from, to);
      refreshed.push(id);
    } else {
      stale.push(id);
    }
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
  if (refreshed.length > 0) {
    process.stdout.write(`refreshed from the bundled version (old copy backed up as .bak): ${refreshed.join(", ")}\n`);
  }
  if (stale.length > 0) {
    process.stdout.write(
      `${stale.length} graph(s) differ from the bundled version: ${stale.join(", ")}\n` +
        `If that's your own edit, ignore this. Otherwise a bug fix may not have reached your copy yet -- ` +
        `re-run \`graph-agent init --refresh\` to take the bundled version (your copy is backed up as <id>.bpmn.bak).\n`,
    );
  }
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

interface RunFlags {
  graph: string;
  model?: string;
  dryRun: boolean;
  name?: string;
  answer?: Record<string, unknown>;
  positionals: string[];
}

function runFlags(args: string[]): RunFlags {
  const { values, positionals } = parseArgs({
    args,
    options: {
      graph: { type: "string", default: "pi-default-loop" },
      model: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      name: { type: "string" },
      answer: { type: "string", multiple: true },
    },
    allowPositionals: true,
    strict: false,
  });
  return {
    graph: String(values.graph ?? "pi-default-loop"),
    ...(values.model === undefined ? {} : { model: String(values.model) }),
    dryRun: values["dry-run"] === true,
    ...(values.name === undefined ? {} : { name: String(values.name) }),
    ...(values.answer === undefined ? {} : { answer: parseAnswers(values.answer as string[]) }),
    positionals: positionals.map(String),
  };
}

/** `key=value` pairs from repeated `--answer`, coercing obvious booleans and numbers. */
function parseAnswers(pairs: string[]): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new Error(`--answer '${pair}' is not 'key=value'`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    answer[key] = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  return answer;
}

async function resolveRunModel(flags: RunFlags, p: Paths): Promise<Awaited<ReturnType<typeof resolveModel>>> {
  return flags.dryRun ? dryRunModel() : resolveModel(flags.model, readConfiguredModel(p.configFile));
}

/**
 * Ctrl-C (or a TERM) aborts the signal `runSession`/`resumeSession` thread down
 * into the engine instead of leaving a runaway graph to keep spending model
 * calls after the terminal looks like it gave control back (issue #30).
 */
async function withInterrupt<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await fn(controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const p = requirePaths();
  if (!p) return 1;
  const flags = runFlags(args);
  const project = projectId();

  const graphFile = graphPath(p, flags.graph);
  if (!graphFile) {
    process.stderr.write(`graph-agent: no graph named '${flags.graph}' in ${p.workflowsDir}\n`);
    return 1;
  }

  let chosen;
  try {
    chosen = await resolveRunModel(flags, p);
  } catch (error) {
    process.stderr.write(`graph-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(`graph  ${flags.graph}\nmodel  ${chosen.label}\n\n`);

  const result = await withInterrupt((signal) =>
    runSession({
      paths: p,
      project,
      graphPath: graphFile,
      prompt: flags.positionals.join(" "),
      ...(flags.name === undefined ? {} : { name: flags.name }),
      model: chosen.model,
      systemPrompt: "",
      streamFn: chosen.streamFn,
      tools: createPiToolExecutor(project),
      onProgress: (line) => process.stdout.write(`  ${line}\n`),
      ...(flags.answer === undefined ? {} : { onWait: () => flags.answer }),
      signal,
    }),
  );

  process.stdout.write(`\nsession ${result.sessionId}  ${result.outcome}  ${result.turns} turn(s)\n`);
  reportWait(p, result.sessionId, result.outcome);
  if (result.error) {
    process.stderr.write(`error: ${result.error.message}\n`);
    return 1;
  }
  return 0;
}

async function cmdResume(args: string[]): Promise<number> {
  const p = requirePaths();
  if (!p) return 1;
  const flags = runFlags(args);
  const sessionId = flags.positionals[0];
  if (!sessionId) {
    process.stderr.write("graph-agent: resume requires a session id\n");
    return 2;
  }

  let chosen;
  try {
    chosen = await resolveRunModel(flags, p);
  } catch (error) {
    process.stderr.write(`graph-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    const result = await withInterrupt((signal) =>
      resumeSession({
        paths: p,
        project: projectId(),
        sessionId,
        model: chosen.model,
        systemPrompt: "",
        streamFn: chosen.streamFn,
        tools: createPiToolExecutor(projectId()),
        onProgress: (line) => process.stdout.write(`  ${line}\n`),
        ...(flags.answer === undefined ? {} : { onWait: () => flags.answer }),
        signal,
      }),
    );
    process.stdout.write(`\nsession ${result.sessionId}  ${result.outcome}  ${result.turns} turn(s)\n`);
    reportWait(p, result.sessionId, result.outcome);
    if (result.error) {
      process.stderr.write(`error: ${result.error.message}\n`);
    }
    return result.error ? 1 : 0;
  } catch (error) {
    process.stderr.write(`graph-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** Names what a stopped run is parked on, so `resume` isn't a guessing game. */
function reportWait(p: Paths, sessionId: string, outcome: string): void {
  if (outcome !== "stopped") return;
  const tokens = new SessionStore(p, sessionId).readMeta().tokens;
  if (tokens.length === 0) return;
  process.stdout.write(
    `waiting on ${tokens.join(", ")}\nresume with: graph-agent resume ${sessionId} --answer key=value\n`,
  );
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
    if (turn.error) process.stdout.write(`       ${turn.error}\n`);
  }
  if (detail.harnessError) process.stdout.write(`\n${detail.harnessError}\n`);
  return 0;
}

const exitCode = await main(process.argv.slice(2));
if (exitCode !== 0) process.exitCode = exitCode;
