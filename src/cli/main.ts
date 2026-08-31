import { parseArgs } from "node:util";
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { graphPath, startStudio } from "../studio/server.ts";
import { resumeSession, runSession } from "../agent/runner.ts";
import { ProcessTerminal } from "../tui/pi-bridge.ts";
import { startTui, type TuiStart } from "../tui/app.ts";
import { firstActivity, pendingGates, processId, withDefinitionsId, withProcessId } from "../agent/graph.ts";
import { formFields } from "../tui/form-fields.ts";
import { unlinkGraph } from "../agent/link.ts";
import { lintBpmn } from "../agent/bpmn-lint.ts";
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
  tui [prompt] | tui --resume <session>
                       start a session in an interactive terminal UI: a live
                       transcript, a trail of the last few activities, and a
                       prompt for any human gate the graph parks on --
                       --resume reattaches to a parked session instead of
                       starting a new one
  resume <session>     recover engine + transcript state and continue
  steer <session> <text>
                       queue a steering message, injected before the next turn
  follow-up <session> <text>
                       queue a follow-up message, drained once the agent would
                       otherwise stop
  ls                   list this project's sessions (--all for every project)
  show <session>       print a session's turns and current graph revision
  report <session>     generate a markdown, html or json execution report
                        (--format <markdown|html|json>, --out <file>, --embed-svg)
  export <session|file>
                       export the workflow or session execution diagram to SVG
                        (--out <file.svg>, --background <color>)
  promote <session> --as <name>
                       write a session's graph (its own callActivity links
                       removed) into the shared library, so a fresh session
                       can start from what it converged on (--revision <n>
                       picks a revision other than the latest, --force
                       overwrites an existing library graph, backed up first)
  studio               serve the studio for this project
  where                print the config, graph library and state directories

Graphs live in your user config directory and are shared across projects.
Sessions live in your user state directory and record the project they ran in.

Options
  --graph <id>         graph to run (default: session-default, a
                        callActivity into pi-default-loop)
  --model <spec>       provider/model to use (default: config.toml's [agent]
                        model, or the first model with credentials)
  --dry-run            walk the graph without calling a model
  --name <name>        label the session
  --answer [activity:]key=value
                        answer a parked human gate reached during run/resume
                        (repeatable). Unscoped (bare key=value) answers apply
                        to whichever gate asks for that key, at every gate
                        that parks during the run -- scope one to a single
                        activity with 'activity:key=value' so a payload
                        meant for one gate (e.g. an intent) is never replayed
                        at another (e.g. an unrelated approval)
  --max-auto-answers <n>
                        how many times run/resume may auto-answer the same
                        gate from --answer before leaving it parked instead
                        (default: 5) -- raise it for a graph that
                        legitimately revisits one gate more than that many
                        times in a single invocation
  --resume <session>  tui only: reattach to a parked session instead of
                        starting a new one ('graph-agent resume' takes the
                        session id positionally instead)
  --steer <text>       queue a steering message before the run starts, drained
                        by the first agent:steer the graph reaches (repeatable)
  --follow-up <text>   queue a follow-up message before the run starts, drained
                        by the first agent:follow-up the graph reaches
                        (repeatable)
  --port <n>           studio port (0 picks a free one)
  --host <addr>        studio bind address (default: loopback only; the
                        studio has no authentication, so a non-loopback
                        --host exposes its write routes to the network)
  --open / --no-open   open the studio URL in a browser (default: --open)
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
    case "report": {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: {
          format: { type: "string" },
          out: { type: "string" },
          "embed-svg": { type: "boolean" },
        },
        allowPositionals: true,
      });
      const { cmdReport } = await import("./report.ts");
      return cmdReport(parsed.positionals[0], {
        format: parsed.values.format,
        out: parsed.values.out,
        embedSvg: parsed.values["embed-svg"],
      });
    }
    case "export": {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: {
          out: { type: "string" },
          background: { type: "string" },
        },
        allowPositionals: true,
      });
      const { cmdExport } = await import("./report.ts");
      return cmdExport(parsed.positionals[0], {
        out: parsed.values.out,
        background: parsed.values.background,
      });
    }
    case "run":
      return cmdRun(argv.slice(1));
    case "tui":
      return cmdTui(argv.slice(1));
    case "resume":
      return cmdResume(argv.slice(1));
    case "steer":
      return cmdQueue("steer", argv.slice(1));
    case "follow-up":
      return cmdQueue("follow-up", argv.slice(1));
    case "promote":
      return cmdPromote(argv.slice(1));
    default:
      process.stderr.write(`graph-agent: unknown command '${command}'\n\n${USAGE}`);
      return 2;
  }
}

function version(): string {
  return "0.1.0";
}

export function requirePaths(): Paths | null {
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

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // Best-effort: no browser opener available is not fatal, the printed URL
    // still works -- but an unhandled 'error' event would otherwise crash
    // the process (spawn() errors are reported asynchronously, so try/catch
    // alone does not catch e.g. a missing `xdg-open`).
    child.once("error", () => {});
    child.unref();
  } catch {
    // Synchronous spawn failure (rare); same best-effort story.
  }
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
      // parseArgs has no built-in `--no-<flag>` negation; a bare `no-open`
      // key is how a boolean's negation shows up (see also #56).
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const shouldOpen = Boolean(values.open) && !values["no-open"];

  const host = values.host === undefined ? undefined : String(values.host);
  let port: number | undefined;
  if (values.port !== undefined) {
    const portRaw = String(values.port);
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      process.stderr.write(`graph-agent: --port must be an integer between 0 and 65535, got '${portRaw}'\n`);
      return 1;
    }
    port = parsed;
  }
  const studio = await startStudio({
    paths: p,
    project,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
  });

  process.stdout.write(`graph-agent studio  ${studio.url}\n`);
  process.stdout.write(`  project   ${projectName(project)}  ${project}\n`);
  process.stdout.write(`  sessions  ${studio.url}/\n`);
  process.stdout.write(`  graphs    ${studio.url}/graph\n`);

  if (host !== undefined && !isLoopbackHost(host)) {
    process.stderr.write(
      `warning: studio has no authentication and is bound to ${host}, which is not loopback -- ` +
        `its write routes (e.g. PUT /api/graphs/:id) are reachable from the network.\n`,
    );
  }

  if (shouldOpen) {
    openInBrowser(studio.url);
  }

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
  answer?: ScopedAnswers;
  steer: string[];
  followUp: string[];
  positionals: string[];
  /** `tui --resume <id>` reattaches instead of starting a new session (issue #67). */
  resume?: string;
  /**
   * Overrides DEFAULT_MAX_AUTO_ANSWERS_PER_ACTIVITY for `run`/`resume` (issue #71). Kept as the raw
   * string the user typed -- not coerced here -- so resolveMaxAutoAnswers can echo it back verbatim
   * in its error instead of a coerced `NaN` (issue #77).
   */
  maxAutoAnswers?: string;
}

/**
 * `--answer` payloads keyed by the activity they answer, `"*"` for an
 * unscoped one that applies to whichever gate asks for that key. See
 * `answersFor` and issue #44: a single global payload replayed at every gate
 * is how `run --graph session-skeleton` used to loop forever, since the
 * intent answer meant for `await_intent` was also fed to `review_fragment`'s
 * approval gate.
 */
type ScopedAnswers = Map<string, Record<string, unknown>>;

const UNSCOPED = "*";

function runFlags(args: string[]): RunFlags {
  const { values, positionals } = parseArgs({
    args,
    options: {
      graph: { type: "string", default: "session-default" },
      model: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      name: { type: "string" },
      answer: { type: "string", multiple: true },
      steer: { type: "string", multiple: true },
      "follow-up": { type: "string", multiple: true },
      resume: { type: "string" },
      "max-auto-answers": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });
  return {
    graph: String(values.graph ?? "session-default"),
    ...(values.model === undefined ? {} : { model: String(values.model) }),
    dryRun: values["dry-run"] === true,
    ...(values.name === undefined ? {} : { name: String(values.name) }),
    ...(values.answer === undefined ? {} : { answer: parseAnswers(values.answer as string[]) }),
    steer: (values.steer as string[] | undefined) ?? [],
    followUp: (values["follow-up"] as string[] | undefined) ?? [],
    positionals: positionals.map(String),
    ...(values.resume === undefined ? {} : { resume: String(values.resume) }),
    ...(values["max-auto-answers"] === undefined ? {} : { maxAutoAnswers: String(values["max-auto-answers"]) }),
  };
}

/**
 * `[activity:]key=value` pairs from repeated `--answer`, coercing obvious
 * booleans and numbers. A colon before the first `=` scopes the pair to one
 * activity id; otherwise it lands in the unscoped bucket. Activity ids never
 * contain `=`, and a value is free to contain `:` (only the first colon
 * ahead of the first `=` is treated as the scope separator), so
 * `--answer command=echo a:b` is `{command: "echo a:b"}` unscoped, and
 * `--answer review_fragment:approval=apply` scopes to `review_fragment`.
 */
export function parseAnswers(pairs: string[]): ScopedAnswers {
  const answers: ScopedAnswers = new Map();
  for (const pair of pairs) {
    const colon = pair.indexOf(":");
    const firstEq = pair.indexOf("=");
    const scoped = colon !== -1 && (firstEq === -1 || colon < firstEq);
    const scope = scoped ? pair.slice(0, colon) : UNSCOPED;
    const rest = scoped ? pair.slice(colon + 1) : pair;

    const eq = rest.indexOf("=");
    if (eq === -1) throw new Error(`--answer '${pair}' is not '[activity:]key=value'`);
    const key = rest.slice(0, eq);
    const raw = rest.slice(eq + 1);

    const bucket = answers.get(scope) ?? {};
    bucket[key] = coerceAnswerValue(raw);
    answers.set(scope, bucket);
  }
  return answers;
}

/**
 * Coerces an obvious boolean or number out of a raw string answer, the way
 * `--answer key=value` always has -- shared with the TUI's gate wizard
 * (`src/tui/app.ts`, issue #50) so a typed "true" or "3" behaves the same
 * whether it came from a flag or an interactive prompt.
 */
export function coerceAnswerValue(raw: string): unknown {
  return raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
}

/** The unscoped bucket merged under whatever is scoped to this activity, or `undefined` when neither exists. */
export function answersFor(answers: ScopedAnswers, activityId: string): Record<string, unknown> | undefined {
  const wildcard = answers.get(UNSCOPED);
  const scoped = answers.get(activityId);
  if (wildcard === undefined && scoped === undefined) return undefined;
  return { ...wildcard, ...scoped };
}

/**
 * Caps how many times the same activity id may be auto-answered from
 * `--answer` in a single run/resume invocation. An unscoped answer is meant
 * to apply wherever its key is asked for, which can legitimately be the same
 * activity more than once (a loop that revisits a gate) -- but nothing else
 * bounds that, so a graph that cannot otherwise terminate would keep
 * replaying the same payload and billing a model turn per lap forever. Once
 * the cap is hit this reports the same "leave it parked, snapshot and stop"
 * outcome an unanswered gate gets, rather than throwing out of an
 * event-emitter callback.
 *
 * Overridable with `--max-auto-answers <n>` (issue #71): a deliberately
 * looping graph driven headlessly (CI, a batch of intents) is otherwise
 * undriveable past this many laps, and the cap message used to tell the
 * reader to "raise the cap" with no way to actually do that.
 */
const DEFAULT_MAX_AUTO_ANSWERS_PER_ACTIVITY = 5;

/** `--max-auto-answers`, validated -- a positive integer, or the default when the flag is absent. */
function resolveMaxAutoAnswers(flags: RunFlags): number | { error: string } {
  if (flags.maxAutoAnswers === undefined) return DEFAULT_MAX_AUTO_ANSWERS_PER_ACTIVITY;
  const parsed = Number(flags.maxAutoAnswers);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { error: `graph-agent: --max-auto-answers must be a positive integer, got '${flags.maxAutoAnswers}'\n` };
  }
  return parsed;
}

export function boundedOnWait(
  answers: ScopedAnswers,
  maxAutoAnswers: number = DEFAULT_MAX_AUTO_ANSWERS_PER_ACTIVITY,
): (activityId: string) => Record<string, unknown> | undefined {
  const seen = new Map<string, number>();
  return (activityId) => {
    const answer = answersFor(answers, activityId);
    if (answer === undefined) return undefined;
    const count = (seen.get(activityId) ?? 0) + 1;
    seen.set(activityId, count);
    if (count > maxAutoAnswers) {
      // A scoped answer (`activity:key=value`) was aimed at this exact gate
      // deliberately -- the cap firing means the graph keeps revisiting it,
      // not that the payload leaked in from elsewhere, so "scope it" is a
      // no-op restating what the user already did (issue #62). Only an
      // unscoped answer, which is meant to apply wherever its key is asked
      // for, gets that advice; a scoped one gets told the graph itself is
      // the thing not terminating.
      const scoped = answers.has(activityId);
      process.stderr.write(
        scoped
          ? `graph-agent: ${activityId} was auto-answered ${count - 1} times with the same payload (the cap is ` +
              `${maxAutoAnswers} per activity); the graph keeps revisiting this gate -- answer whatever ends the ` +
              `loop (e.g. a 'done' or 'approved' field), or raise the cap with --max-auto-answers.\n`
          : `graph-agent: ${activityId} was auto-answered ${count - 1} times with the same payload (the cap is ` +
              `${maxAutoAnswers} per activity); scope your answer with --answer ${activityId}:key=value if it ` +
              `should not be replayed here, or raise the cap with --max-auto-answers.\n`,
      );
      return undefined;
    }
    return answer;
  };
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

  const prompt = flags.positionals.join(" ");
  if (prompt) {
    // A user task parks on its own form and never reads the "prompt" process
    // variable runSession seeds -- a graph whose first stop is one (like
    // session-skeleton's await_intent) would otherwise accept a positional
    // prompt and silently never use it anywhere (issue #47).
    const first = await firstActivity(readFileSync(graphFile, "utf8"));
    if (first?.type === "bpmn:UserTask") {
      process.stderr.write(
        `graph-agent: '${flags.graph}' starts on '${first.id}', a human gate that reads its own form, ` +
          `not the initial prompt -- it would never see "${prompt}". Answer it directly instead: ` +
          `graph-agent run --graph ${flags.graph} --answer ${first.id}:key=value\n`,
      );
      return 1;
    }
  }

  let chosen;
  try {
    chosen = await resolveRunModel(flags, p);
  } catch (error) {
    process.stderr.write(`graph-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const maxAutoAnswers = resolveMaxAutoAnswers(flags);
  if (typeof maxAutoAnswers !== "number") {
    process.stderr.write(maxAutoAnswers.error);
    return 1;
  }

  process.stdout.write(`graph  ${flags.graph}\nmodel  ${chosen.label}\n\n`);

  const result = await withInterrupt((signal) =>
    runSession({
      paths: p,
      project,
      graphPath: graphFile,
      prompt,
      ...(flags.name === undefined ? {} : { name: flags.name }),
      model: chosen.model,
      systemPrompt: "",
      streamFn: chosen.streamFn,
      tools: createPiToolExecutor(project),
      onProgress: (line) => process.stdout.write(`  ${line}\n`),
      ...(flags.answer === undefined ? {} : { onWait: boundedOnWait(flags.answer, maxAutoAnswers) }),
      ...(flags.steer.length === 0 ? {} : { steering: flags.steer }),
      ...(flags.followUp.length === 0 ? {} : { followUp: flags.followUp }),
      signal,
    }),
  );

  process.stdout.write(`\nsession ${result.sessionId}  ${result.outcome}  ${result.turns} turn(s)\n`);
  await reportWait(p, result.sessionId, result.outcome);
  if (result.error) {
    process.stderr.write(`error: ${result.error.message}\n`);
    return 1;
  }
  return 0;
}

async function cmdTui(args: string[]): Promise<number> {
  const p = requirePaths();
  if (!p) return 1;
  const flags = runFlags(args);
  const project = projectId();

  let start: TuiStart;
  if (flags.resume !== undefined) {
    // A resumed session already carries its own graph, model choice and
    // prompt history -- `--graph`/a positional prompt would be meaningless
    // here, unlike `graph-agent resume`, which never took a graph flag
    // either (issue #67).
    start = { kind: "resume", sessionId: flags.resume };
  } else {
    const graphFile = graphPath(p, flags.graph);
    if (!graphFile) {
      process.stderr.write(`graph-agent: no graph named '${flags.graph}' in ${p.workflowsDir}\n`);
      return 1;
    }

    const prompt = flags.positionals.join(" ");
    if (prompt) {
      const first = await firstActivity(readFileSync(graphFile, "utf8"));
      if (first?.type === "bpmn:UserTask") {
        process.stderr.write(
          `graph-agent: '${flags.graph}' starts on '${first.id}', a human gate that reads its own form, ` +
            `not the initial prompt -- the tui will prompt for it interactively instead.\n`,
        );
      }
    }
    start = {
      kind: "run",
      graphPath: graphFile,
      graphLabel: flags.graph,
      prompt,
      ...(flags.name === undefined ? {} : { name: flags.name }),
    };
  }

  let chosen;
  try {
    chosen = await resolveRunModel(flags, p);
  } catch (error) {
    process.stderr.write(`graph-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let result;
  try {
    result = await withInterrupt((signal) =>
      startTui({
        paths: p,
        project,
        start,
        model: chosen.model,
        modelLabel: chosen.label,
        systemPrompt: "",
        streamFn: chosen.streamFn,
        tools: createPiToolExecutor(project),
        terminal: new ProcessTerminal(),
        coerceValue: coerceAnswerValue,
        signal,
      }),
    );
  } catch (error) {
    process.stderr.write(`graph-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(`\nsession ${result.sessionId}  ${result.outcome}  ${result.turns} turn(s)\n`);
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

  const maxAutoAnswers = resolveMaxAutoAnswers(flags);
  if (typeof maxAutoAnswers !== "number") {
    process.stderr.write(maxAutoAnswers.error);
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
        ...(flags.answer === undefined ? {} : { onWait: boundedOnWait(flags.answer, maxAutoAnswers) }),
      ...(flags.steer.length === 0 ? {} : { steering: flags.steer }),
      ...(flags.followUp.length === 0 ? {} : { followUp: flags.followUp }),
        signal,
      }),
    );
    process.stdout.write(`\nsession ${result.sessionId}  ${result.outcome}  ${result.turns} turn(s)\n`);
    await reportWait(p, result.sessionId, result.outcome);
    if (result.error) {
      process.stderr.write(`error: ${result.error.message}\n`);
    }
    return result.error ? 1 : 0;
  } catch (error) {
    process.stderr.write(`graph-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Names what a stopped run is parked on, so `resume` isn't a guessing game --
 * and, critically, only ever suggests `--answer` for a token that is actually
 * a human gate. `meta.tokens` is every activity the token rests on (service
 * tasks and callActivities mid-flight included, not just `bpmn:UserTask`s),
 * and the naive `tokens[0]` used to suggest answering whichever of those
 * happened to come first -- a `shell` step, a `callActivity`, anything --
 * which `--answer` can never actually satisfy (issue #61). `pendingGates`
 * (already used by the studio) does the real filtering, and its form schema
 * (when the gate has one) names the actual field to answer rather than the
 * literal placeholder `key`.
 */
export async function reportWait(p: Paths, sessionId: string, outcome: string): Promise<void> {
  if (outcome !== "stopped") return;
  const store = new SessionStore(p, sessionId);
  const meta = store.readMeta();
  if (meta.tokens.length === 0) return;
  process.stdout.write(`waiting on ${meta.tokens.join(", ")}\n`);

  const xml = store.currentGraph();
  const gates = xml ? await pendingGates(xml, meta.tokens) : [];
  if (gates.length === 0) {
    process.stdout.write(`nothing here is a human gate; resume with: graph-agent resume ${sessionId}\n`);
    return;
  }
  for (const gate of gates) {
    const key = gate.form ? (formFields(gate.form.schema, gate.name ?? gate.id)[0]?.key ?? "key") : "key";
    process.stdout.write(`answer with: graph-agent resume ${sessionId} --answer ${gate.id}:${key}=value\n`);
  }
}

function formatCost(costUSD?: number): string {
  if (costUSD === undefined || costUSD === 0) return "";
  if (costUSD < 0.01) return `$${costUSD.toFixed(4)}`;
  return `$${costUSD.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
    const cost = s.stats?.totalCostUSD ? `  ${formatCost(s.stats.totalCostUSD)}` : "";
    process.stdout.write(
      `${s.id}  ${s.status.padEnd(9)}  ${String(s.turnCount).padStart(3)} turns${cost}${where}  ${s.name ?? ""}\n`,
    );
  }
  return 0;
}

/**
 * Queues a steering/follow-up message into a session's inbox from *outside*
 * whatever process is (or next is) driving it -- see `SessionStore.queueInbox`
 * and issue #48. Works whether or not a run is currently in flight: a queued
 * message sits in `inbox.jsonl` until the graph's own `agent:steer`/
 * `agent:follow-up` activity next drains it.
 */
function cmdQueue(kind: "steer" | "follow-up", args: string[]): number {
  const p = requirePaths();
  if (!p) return 1;
  const [id, ...rest] = args;
  const text = rest.join(" ");
  if (!id || !text) {
    process.stderr.write(`graph-agent: ${kind} requires a session id and a message\n`);
    return 2;
  }
  const store = new SessionStore(p, id);
  if (!store.exists()) {
    process.stderr.write(`graph-agent: unknown session '${id}'\n`);
    return 1;
  }
  store.queueInbox(kind, text);
  process.stdout.write(
    `queued ${kind} message for ${id}; it is drained the next time the graph reaches agent:${kind}\n`,
  );
  return 0;
}

/** Library graph ids/filenames are plain identifiers; sanitize a definitions id the same way. */
function sanitizeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Writes a session's graph -- with the processes `linkGraph` inlined into it
 * removed -- into the shared library, so a fresh session can start from
 * whatever it converged on instead of that work staying buried in a state
 * directory (issue #55). The library → session → mutate → promote → library
 * round trip is the last step "iterate towards re-usable definitions" needs.
 */
async function cmdPromote(args: string[]): Promise<number> {
  const p = requirePaths();
  if (!p) return 1;
  const { values, positionals } = parseArgs({
    args,
    options: {
      as: { type: "string" },
      revision: { type: "string" },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const sessionId = positionals[0];
  if (!sessionId) {
    process.stderr.write("graph-agent: promote requires a session id\n");
    return 2;
  }
  const name = values.as === undefined ? undefined : String(values.as);
  if (!name) {
    process.stderr.write("graph-agent: promote requires --as <name> to name the library graph\n");
    return 2;
  }

  const store = new SessionStore(p, sessionId);
  if (!store.exists()) {
    process.stderr.write(`graph-agent: unknown session '${sessionId}'\n`);
    return 1;
  }

  const revisionFiles = store.graphRevisionFiles();
  if (revisionFiles.length === 0) {
    process.stderr.write(`graph-agent: session '${sessionId}' has no graph\n`);
    return 1;
  }
  let revisionIndex = revisionFiles.length - 1;
  if (values.revision !== undefined) {
    const parsed = Number(values.revision);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed >= revisionFiles.length) {
      process.stderr.write(
        `graph-agent: --revision ${String(values.revision)} is out of range (session '${sessionId}' has revisions 0-${revisionFiles.length - 1})\n`,
      );
      return 1;
    }
    revisionIndex = parsed;
  }
  const revisionXml = readFileSync(join(store.graphDir, revisionFiles[revisionIndex]!), "utf8");

  const { xml: unlinkedXml, unlinked } = await unlinkGraph(revisionXml);
  const newProcessId = sanitizeId(name);
  const promotedXml = await withProcessId(
    await withDefinitionsId(unlinkedXml, `Defs_${newProcessId}`),
    newProcessId,
  );

  const lint = await lintBpmn(promotedXml);
  if (lint.errors > 0) {
    process.stderr.write(
      `graph-agent: revision ${revisionIndex} of '${sessionId}' fails bpmnlint and was not promoted:\n` +
        lint.lines.map((line) => `  ${line}\n`).join(""),
    );
    return 1;
  }

  const target = join(p.workflowsDir, `${name}.bpmn`);
  if (existsSync(target) && !values.force) {
    process.stderr.write(
      `graph-agent: '${name}.bpmn' already exists in the library; pass --force to overwrite it (backed up as '${name}.bpmn.bak' first)\n`,
    );
    return 1;
  }
  // calledElement names a *process*, not a file -- indexLibrary resolves a
  // shared process id with last-write-wins, so two library files defining
  // the same process silently make which one a callActivity actually
  // reaches a function of directory order (issue #64).
  if (!values.force) {
    for (const { path: otherPath } of listBpmnFiles(p.workflowsDir)) {
      if (otherPath === target) continue;
      if ((await processId(readFileSync(otherPath, "utf8"))) === newProcessId) {
        process.stderr.write(
          `graph-agent: process id '${newProcessId}' is already used by ${otherPath}; ` +
            `pass --force to promote anyway, or choose a different --as\n`,
        );
        return 1;
      }
    }
  }
  if (existsSync(target)) copyFileSync(target, `${target}.bak`);
  writeFileSync(target, promotedXml);

  process.stdout.write(
    `promoted revision ${revisionIndex} of ${sessionId} to ${target}, callable as calledElement="${newProcessId}"\n` +
      (unlinked.length > 0 ? `unlinked (still callable via calledElement): ${unlinked.join(", ")}\n` : ""),
  );
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
  const stats = detail.stats;
  const costStr = stats?.totalCostUSD ? ` · cost ${formatCost(stats.totalCostUSD)}` : "";
  const tokenStr = stats?.totalTokens
    ? ` · tokens ${formatTokens(stats.totalTokens)} (${Math.round(stats.cacheHitRatio * 100)}% cached)`
    : "";
  process.stdout.write(`${detail.id}  ${detail.status}  ${detail.turnCount} turns${tokenStr}${costStr}\n`);
  process.stdout.write(`project: ${detail.project}\n`);
  process.stdout.write(`tokens: ${detail.tokens.join(", ") || "-"}\n`);
  process.stdout.write(`graph revisions: ${detail.revisions.length}\n\n`);
  for (const turn of detail.turns) {
    const turnCost = turn.usage?.cost?.total ? ` (${formatCost(turn.usage.cost.total)})` : "";
    const turnTokens = turn.usage
      ? ` [in:${turn.usage.input} out:${turn.usage.output} cache:${turn.usage.cacheRead}]`
      : "";
    process.stdout.write(
      `${String(turn.index).padStart(3)}  ${turn.activityId}  ${turn.harness ?? ""}  ${turn.stopReason ?? ""}${turnTokens}${turnCost}\n`,
    );
    if (turn.error) process.stdout.write(`       ${turn.error}\n`);
  }
  if (detail.harnessError) process.stdout.write(`\n${detail.harnessError}\n`);
  return 0;
}

/**
 * A consumer downstream of a pipe (`graph-agent ls | head -5`) can close it
 * before every write lands; Node turns that into an unhandled 'error' event
 * -- an EPIPE stack dump -- unless something is listening. Real CLIs treat it
 * as an early, clean exit instead.
 */
export function installEpipeGuard(streams: Array<NodeJS.WritableStream>): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
}

// Guarded so importing this module (as the test below does) does not also run
// the CLI against the test runner's own argv. realpath on argv[1] because an
// installed `graph-agent` binary is a symlink node does not itself resolve
// the way import.meta.url does.
function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  installEpipeGuard([process.stdout, process.stderr]);
  const exitCode = await main(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}
