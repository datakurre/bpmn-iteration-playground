/**
 * `graph-agent tui`: the same `runSession` the plain CLI uses, driven from an
 * interactive terminal instead of one `process.stdout.write` per activity.
 *
 * `docs/research/06-tui.md` is the design this follows: build on `pi-tui`
 * directly rather than embedding Pi's own `InteractiveMode` (which owns its
 * loop -- exactly what this project hands to the diagram instead), reuse
 * `AssistantMessageComponent`/`ToolExecutionComponent` a la carte through
 * `pi-bridge.ts`, and keep the graph in charge: the editor only ever queues
 * steering/follow-up messages or answers a parked gate, it never starts a
 * turn on its own.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { firstActivity, graphOutline, pendingGates } from "../agent/graph.ts";
import { bundledWorkflowsDir, listBpmnFiles, type Paths } from "../agent/paths.ts";
import { promoteSession } from "../agent/promote.ts";
import type { PiSession } from "../agent/pi-session.ts";
import { resumeSession, runSession, type RunSessionOptions, type SessionOutcome } from "../agent/runner.ts";
import { listSessions, SessionStore } from "../agent/session-store.ts";
import type { ToolExecutor } from "../agent/tool-executor.ts";
import { listAvailableModels, resolveModel } from "../cli/model.ts";
import type { Studio } from "../studio/server.ts";
import { formFields } from "./form-fields.ts";
import {
  assistantMessageComponent,
  CombinedAutocompleteProvider,
  Container,
  diffPreviewComponent,
  DynamicBorder,
  Editor,
  getSelectListTheme,
  HStack,
  SelectList,
  streamingAssistantComponent,
  Text,
  toolTranscriptEntry,
  TuiMainScreen,
  userMessageComponent,
  type Component,
  type EditorTheme,
  type StreamingAssistantEntry,
  type Terminal,
  type ToolTranscriptEntry,
} from "./pi-bridge.ts";

export type TuiStart =
  | {
      kind: "run";
      graphPath: string;
      /** For the status strip -- the `--graph` name, not the resolved file path. */
      graphLabel: string;
      prompt?: string;
      name?: string;
    }
  | { kind: "resume"; sessionId: string };

export interface TuiAppOptions {
  paths: Paths;
  project: string;
  start: TuiStart;
  model: RunSessionOptions["model"];
  modelLabel: string;
  systemPrompt: string;
  streamFn: RunSessionOptions["streamFn"];
  tools: ToolExecutor;
  /** Injectable so a test can drive the whole app against a fake, without a real pty. */
  terminal: Terminal;
  signal?: AbortSignal;
  /** Coerces a wizard-typed string the way `--answer key=value` always has. Defaults to identity. */
  coerceValue?: (raw: string) => unknown;
  /** How many trailing activities the trail shows. */
  trailSize?: number;
  onReady?: (handles: TuiHandles) => void;
}

export interface TuiHandles {
  editor: Editor;
  root: Component;
}

/** A parked human gate mid-answer: the wizard asks one field at a time. */
interface GateWizard {
  activityId: string;
  fields: ReturnType<typeof formFields>;
  index: number;
  values: Record<string, unknown>;
  resolve: (payload: Record<string, unknown> | undefined) => void;
}

/** Runs `graph-agent tui` end to end and resolves once the session settles. */
export async function startTui(options: TuiAppOptions): Promise<SessionOutcome> {
  const sessionId = options.start.kind === "resume" ? options.start.sessionId : randomUUID().slice(0, 8);
  const store = new SessionStore(options.paths, sessionId);
  const coerce = options.coerceValue ?? ((raw: string) => raw);
  const defaultTrailSize = options.terminal.rows < 20 ? 3 : 5;
  const trailSize = options.trailSize ?? defaultTrailSize;
  const graphLabel =
    options.start.kind === "run"
      ? options.start.graphLabel
      : (store.exists() ? store.readMeta().graph : undefined) ?? "(resumed)";

  const tui = new TuiMainScreen(options.terminal);
  const transcript = new Container();
  const trailText = new Text("");
  const gateText = new Text("");
  const statusText = new Text("");

  const selectListTheme = getSelectListTheme();
  const editorTheme: EditorTheme = {
    borderColor: (text: string) => text,
    selectList: selectListTheme,
  };
  const editor = new Editor(tui, editorTheme);

  const autocompleteProvider = new CombinedAutocompleteProvider(
    [
      { name: "model", description: "view or switch active model", argumentHint: "[provider/model]" },
      { name: "diff", description: "view uncommitted workspace git diff", argumentHint: "[args]" },
      { name: "compact", description: "compact conversation history to reclaim context tokens" },
      { name: "graph", description: "view workflow outline (active session or named graph)", argumentHint: "[name]" },
      { name: "graphs", description: "list available workflows in library" },
      { name: "rail", description: "toggle live side rail showing BPMN sequence flow tree" },
      { name: "promote", description: "promote active session graph to shared library", argumentHint: "<name> [--force]" },
      { name: "sessions", description: "list recent sessions" },
      { name: "studio", description: "launch or view studio URL" },
      { name: "steer", description: "queue a steering message before next turn", argumentHint: "<text>" },
      { name: "follow", description: "queue a follow-up message when agent finishes", argumentHint: "<text>" },
      { name: "clear", description: "clear current transcript screen" },
      { name: "help", description: "show help and keybindings" },
      { name: "exit", description: "quit the session" },
    ],
    options.project,
  );
  editor.setAutocompleteProvider(autocompleteProvider);

  const mainContainer = new Container();
  mainContainer.addChild(transcript);
  mainContainer.addChild(new DynamicBorder());
  mainContainer.addChild(trailText);
  mainContainer.addChild(gateText);
  mainContainer.addChild(editor);
  mainContainer.addChild(statusText);

  const railContainer = new Container();
  const railHeader = new Text("── BPMN Flow Tree ──\n");
  const railOutlineText = new Text("");
  railContainer.addChild(railHeader);
  railContainer.addChild(railOutlineText);

  const splitStack = new HStack();
  let railMode = false;

  const root = new Container();
  tui.addChild(root);
  tui.setFocus(editor);

  async function updateRail(): Promise<void> {
    if (!railMode) return;
    const xml =
      store.currentGraph() ??
      (options.start.kind === "run" && existsSync(options.start.graphPath)
        ? readFileSync(options.start.graphPath, "utf8")
        : "");
    if (!xml) {
      railOutlineText.setText(`graph: ${graphLabel}`);
    } else {
      const meta = store.exists() ? store.readMeta() : undefined;
      const outline = await graphOutline(xml, meta ? { visited: meta.visited, tokens: meta.tokens } : undefined);
      railOutlineText.setText(outline);
    }
    tui.requestRender();
  }

  function applyLayout(): void {
    root.clear();
    if (!railMode) {
      root.addChild(mainContainer);
    } else {
      splitStack.clear();
      splitStack.addChild(mainContainer, { grow: 1 });
      splitStack.addChild(railContainer, { basis: 34 });
      root.addChild(splitStack);
      void updateRail();
    }
    tui.requestRender();
  }

  applyLayout();

  const trail: string[] = [];
  let activeGate: GateWizard | undefined;
  let waitingForPrompt: ((prompt: string | undefined) => void) | undefined;
  let studioServer: Studio | undefined;
  let activePiSession: PiSession | undefined;

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function formatCost(costUSD?: number): string {
    if (costUSD === undefined || costUSD === 0) return "";
    if (costUSD < 0.01) return `$${costUSD.toFixed(4)}`;
    return `$${costUSD.toFixed(2)}`;
  }

  function refreshStatus(state: "running" | "idle" | "waiting" = "running"): void {
    if (!store.exists()) {
      const stateSuffix = state === "idle" ? "enter prompt to start" : "starting…";
      statusText.setText(`graph ${graphLabel} · model ${options.modelLabel} · session ${sessionId} · ${stateSuffix}`);
      if (railMode) void updateRail();
      tui.requestRender();
      return;
    }
    const meta = store.readMeta();
    const stats = meta.turns.reduce(
      (acc, turn) => {
        const u = turn.usage;
        return {
          input: acc.input + (u?.input ?? 0),
          output: acc.output + (u?.output ?? 0),
          cacheRead: acc.cacheRead + (u?.cacheRead ?? 0),
          totalTokens: acc.totalTokens + (u?.totalTokens ?? ((u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0))),
          costUSD: acc.costUSD + (u?.cost?.total ?? 0),
        };
      },
      { input: 0, output: 0, cacheRead: 0, totalTokens: 0, costUSD: 0 },
    );
    const at = meta.tokens.length > 0 ? meta.tokens.join(", ") : "-";
    const statePrefix = state === "idle" ? "idle · " : state === "waiting" ? "waiting · " : "";
    const cacheHit = stats.input > 0 ? ` (${Math.round((stats.cacheRead / stats.input) * 100)}%)` : "";
    const costPart = stats.costUSD > 0 ? ` · ${formatCost(stats.costUSD)}` : "";
    const tokenPart = stats.totalTokens > 0 ? ` · tokens ${formatTokens(stats.totalTokens)}` : "";
    statusText.setText(
      `${statePrefix}graph ${graphLabel} · ${meta.turns.length} turn(s)${tokenPart} · cache ${stats.cacheRead}/${stats.input}${cacheHit}${costPart} · ` +
        `revision ${Math.max(meta.revisions.length - 1, 0)} · at ${at} · session ${sessionId}`,
    );
    if (railMode) void updateRail();
    if (studioServer) studioServer.broadcast({ type: "session_changed", sessionId });
    tui.requestRender();
  }

  function pushTrail(line: string): void {
    trail.unshift(line);
    trail.length = Math.min(trail.length, trailSize);
    trailText.setText(trail.join("\n"));
    tui.requestRender();
  }

  function renderGatePrompt(): void {
    if (!activeGate) {
      gateText.setText("");
      return;
    }
    const field = activeGate.fields[activeGate.index];
    gateText.setText(
      field ? `[gate] waiting on ${activeGate.activityId} — ${field.label} (${field.key}): ` : "",
    );
  }

  function wireTranscript(pi: PiSession): void {
    activePiSession = pi;
    const toolEntries = new Map<string, ToolTranscriptEntry>();
    let streamingEntry: StreamingAssistantEntry | undefined;

    pi.agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        streamingEntry = streamingAssistantComponent(event.message as AssistantMessage);
        transcript.addChild(streamingEntry.component);
        tui.requestRender();
      } else if (event.type === "message_update" && event.message.role === "assistant") {
        if (!streamingEntry) {
          streamingEntry = streamingAssistantComponent(event.message as AssistantMessage);
          transcript.addChild(streamingEntry.component);
        }
        streamingEntry.update(event.message as AssistantMessage, true);
        tui.requestRender();
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (streamingEntry) {
          streamingEntry.update(event.message as AssistantMessage, false);
          streamingEntry = undefined;
        } else {
          transcript.addChild(assistantMessageComponent(event.message as AssistantMessage));
        }
        tui.requestRender();
      } else if (event.type === "tool_execution_start") {
        const entry = toolTranscriptEntry(event.toolName, event.toolCallId, event.args, tui, options.project);
        toolEntries.set(event.toolCallId, entry);
        transcript.addChild(entry.component as Component);
        tui.requestRender();
      } else if (event.type === "tool_execution_end") {
        const entry = toolEntries.get(event.toolCallId);
        toolEntries.delete(event.toolCallId);
        entry?.setResult({ content: event.result?.content ?? [], isError: event.isError });
        tui.requestRender();
      }
    });
  }

  async function onWait(activityId: string): Promise<Record<string, unknown> | undefined> {
    const xml = store.currentGraph();
    const gates = xml ? await pendingGates(xml, [activityId]) : [];
    const gate = gates[0];
    const fallbackLabel = gate?.name ?? activityId;
    const fields = gate?.form ? formFields(gate.form.schema, fallbackLabel) : [{ key: "value", label: fallbackLabel }];
    if (gate?.documentation && (gate.documentation.includes("---") || gate.documentation.includes("+++") || gate.documentation.includes("@@"))) {
      transcript.addChild(diffPreviewComponent(gate.documentation));
      tui.requestRender();
    }
    return new Promise((resolve) => {
      activeGate = { activityId, fields, index: 0, values: {}, resolve };
      renderGatePrompt();
      refreshStatus("waiting");
      tui.requestRender();
    });
  }

  editor.onSubmit = async (raw: string) => {
    const text = raw.trim();
    editor.setText("");
    if (!text) return;

    if (text === "/exit" || text === "/quit") {
      if (waitingForPrompt) {
        const resolve = waitingForPrompt;
        waitingForPrompt = undefined;
        resolve(undefined);
        return;
      }
    }

    if (text === "/help") {
      transcript.addChild(
        new Text(
          [
            "Commands:",
            "  /model [name]    view or switch active model (or select from available)",
            "  /diff [args]     view uncommitted workspace git diff",
            "  /compact         compact conversation history to reclaim context tokens",
            "  /graph [name]    view workflow outline (active session or named graph)",
            "  /graphs          list available workflows in library",
            "  /rail            toggle live side rail with BPMN sequence flow tree",
            "  /promote <name>  promote active session graph to shared library",
            "  /sessions        list recent sessions",
            "  /studio          launch or view studio URL",
            "  /steer <text>    queue steering input before next turn",
            "  /follow <text>   queue follow-up input when run finishes",
            "  /clear           clear transcript",
            "  /help            show this help",
            "  /exit, /quit     exit the session",
          ].join("\n"),
        ),
      );
      tui.requestRender();
      return;
    }

    if (text === "/clear") {
      transcript.clear();
      tui.requestRender();
      return;
    }

    if (text === "/diff" || text.startsWith("/diff ")) {
      const extraArgs = text.startsWith("/diff ") ? text.slice("/diff ".length).trim().split(/\s+/).filter(Boolean) : [];
      try {
        const gitRes = spawnSync("git", ["diff", ...extraArgs], {
          cwd: options.project,
          encoding: "utf8",
        });
        if (gitRes.error) {
          transcript.addChild(new Text(`diff error: ${gitRes.error.message}`));
        } else if (gitRes.status !== 0) {
          transcript.addChild(new Text(`diff error: ${gitRes.stderr || `git diff exited ${gitRes.status}`}`));
        } else if (!gitRes.stdout || !gitRes.stdout.trim()) {
          transcript.addChild(new Text("no uncommitted changes in workspace"));
        } else {
          transcript.addChild(diffPreviewComponent(gitRes.stdout));
        }
      } catch (err) {
        transcript.addChild(new Text(`diff error: ${err instanceof Error ? err.message : String(err)}`));
      }
      tui.requestRender();
      return;
    }

    if (text === "/compact") {
      if (!activePiSession) {
        transcript.addChild(new Text("no active conversation in session yet"));
      } else {
        const res = activePiSession.compactHistory();
        if (res.beforeCount === res.afterCount) {
          transcript.addChild(new Text(`conversation context is already compact (${res.afterCount} message(s))`));
        } else {
          transcript.addChild(
            new Text(`compacted conversation context: ${res.beforeCount} message(s) -> ${res.afterCount} message(s)`),
          );
          refreshStatus();
        }
      }
      tui.requestRender();
      return;
    }

    if (text === "/model" || text.startsWith("/model ")) {
      const targetSpec = text.startsWith("/model ") ? text.slice("/model ".length).trim() : undefined;
      if (targetSpec) {
        try {
          const resolved = await resolveModel(targetSpec);
          options.model = resolved.model;
          options.modelLabel = resolved.label;
          options.streamFn = resolved.streamFn;
          activePiSession?.setModel(resolved.model, resolved.streamFn);
          if (store.exists()) {
            store.update((m) => {
              m.model = resolved.label;
            });
          }
          transcript.addChild(new Text(`switched model to ${resolved.label}`));
          refreshStatus();
        } catch (err) {
          transcript.addChild(new Text(`model error: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        try {
          const available = await listAvailableModels();
          if (available.length === 0) {
            transcript.addChild(new Text(`model: ${options.modelLabel} (no other configured providers found)`));
          } else {
            const selectItems = available.map((m) => {
              const id = `${m.provider}/${m.id}`;
              const isCurrent = id === options.modelLabel || m.id === options.modelLabel;
              return {
                value: id,
                label: `${id}${isCurrent ? " (active)" : ""}`,
                description: m.name ?? "",
              };
            });
            const selectList = new SelectList(selectItems, 10, selectListTheme);
            const modalContainer = new Container();
            modalContainer.addChild(new Text("Select model (Enter to select, Esc to cancel):"));
            modalContainer.addChild(selectList);

            const cleanupModal = () => {
              mainContainer.removeChild(modalContainer);
              tui.setFocus(editor);
              tui.requestRender();
            };

            selectList.onSelect = async (item) => {
              cleanupModal();
              try {
                const resolved = await resolveModel(item.value);
                options.model = resolved.model;
                options.modelLabel = resolved.label;
                options.streamFn = resolved.streamFn;
                activePiSession?.setModel(resolved.model, resolved.streamFn);
                if (store.exists()) {
                  store.update((m) => {
                    m.model = resolved.label;
                  });
                }
                transcript.addChild(new Text(`switched model to ${resolved.label}`));
                refreshStatus();
              } catch (err) {
                transcript.addChild(new Text(`model error: ${err instanceof Error ? err.message : String(err)}`));
                tui.requestRender();
              }
            };

            selectList.onCancel = () => {
              cleanupModal();
            };

            mainContainer.addChild(modalContainer);
            tui.setFocus(selectList);
          }
        } catch (err) {
          transcript.addChild(new Text(`model: ${options.modelLabel}`));
        }
      }
      tui.requestRender();
      return;
    }

    if (text === "/rail") {
      railMode = !railMode;
      applyLayout();
      transcript.addChild(new Text(`side rail ${railMode ? "enabled (live sequence flow active)" : "disabled"}`));
      tui.requestRender();
      return;
    }

    if (text === "/graphs") {
      const libraryFiles = listBpmnFiles(options.paths.workflowsDir);
      const bundledDir = bundledWorkflowsDir();
      const bundledFiles = existsSync(bundledDir) ? listBpmnFiles(bundledDir) : [];
      const allGraphs = new Map<string, string>();
      for (const b of bundledFiles) allGraphs.set(b.id, "bundled");
      for (const l of libraryFiles) allGraphs.set(l.id, "library");

      const lines = ["Available workflows:"];
      for (const [id, source] of allGraphs.entries()) {
        const isCurrent = id === graphLabel ? " (active)" : "";
        lines.push(`  ${id}${isCurrent}  [${source}]`);
      }
      transcript.addChild(new Text(lines.join("\n")));
      tui.requestRender();
      return;
    }

    if (text === "/graph" || text.startsWith("/graph ")) {
      const targetName = text.startsWith("/graph ") ? text.slice("/graph ".length).trim() : undefined;
      if (!targetName) {
        const xml =
          store.currentGraph() ??
          (options.start.kind === "run" && existsSync(options.start.graphPath)
            ? readFileSync(options.start.graphPath, "utf8")
            : "");
        if (!xml) {
          transcript.addChild(new Text(`graph: ${graphLabel}`));
        } else {
          const meta = store.exists() ? store.readMeta() : undefined;
          const outline = await graphOutline(xml, meta ? { visited: meta.visited, tokens: meta.tokens } : undefined);
          transcript.addChild(new Text(`graph: ${graphLabel}\n\n${outline}`));
        }
      } else {
        const libPath = join(options.paths.workflowsDir, `${targetName}.bpmn`);
        const bundledPath = join(bundledWorkflowsDir(), `${targetName}.bpmn`);
        const filePath = existsSync(libPath) ? libPath : existsSync(bundledPath) ? bundledPath : undefined;
        if (!filePath) {
          transcript.addChild(new Text(`graph '${targetName}' not found in library or bundled workflows. Type /graphs to list.`));
        } else {
          const xml = readFileSync(filePath, "utf8");
          const outline = await graphOutline(xml);
          transcript.addChild(new Text(`graph: ${targetName} (${filePath})\n\n${outline}`));
        }
      }
      tui.requestRender();
      return;
    }

    if (text === "/promote" || text.startsWith("/promote ")) {
      const parts = text.slice("/promote".length).trim().split(/\s+/).filter(Boolean);
      const name = parts.find((p) => !p.startsWith("-"));
      const force = parts.includes("--force") || parts.includes("-f");
      if (!name) {
        transcript.addChild(new Text("usage: /promote <name> [--force]"));
        tui.requestRender();
        return;
      }
      const result = await promoteSession({
        paths: options.paths,
        sessionId,
        name,
        force,
      });
      if (result.success) {
        transcript.addChild(new Text(`promoted session graph to library: ${result.targetPath}`));
      } else {
        transcript.addChild(new Text(`promote error: ${result.error}`));
      }
      tui.requestRender();
      return;
    }

    if (text === "/sessions") {
      const sessions = listSessions(options.paths, options.project).slice(0, 10);
      if (sessions.length === 0) {
        transcript.addChild(new Text("no sessions in this project yet"));
      } else {
        const lines = ["Recent sessions:"];
        for (const s of sessions) {
          const sum = s.summary();
          const meta = s.readMeta();
          const graphName = meta.graph ?? "";
          const isCurrent = sum.id === sessionId ? " (current)" : "";
          lines.push(
            `  ${sum.id}${isCurrent}  ${sum.status.padEnd(9)}  ${String(sum.turnCount).padStart(2)} turn(s)  ${graphName}`,
          );
        }
        transcript.addChild(new Text(lines.join("\n")));
      }
      tui.requestRender();
      return;
    }

    if (text === "/studio") {
      try {
        if (!studioServer) {
          const { startStudio } = await import("../studio/server.ts");
          studioServer = await startStudio({
            paths: options.paths,
            project: options.project,
            host: "127.0.0.1",
            port: 0,
          });
        }
        transcript.addChild(new Text(`studio: ${studioServer.url}/sessions/${sessionId}`));
      } catch (err) {
        transcript.addChild(new Text(`studio error: ${err instanceof Error ? err.message : String(err)}`));
      }
      tui.requestRender();
      return;
    }

    if (text.startsWith("/")) {
      if (text.startsWith("/follow ")) {
        if (!store.exists()) return;
        const payload = text.slice("/follow ".length).trim();
        store.queueInbox("follow-up", payload);
        transcript.addChild(new Text(`[queued follow-up] ${payload}`));
        tui.requestRender();
        return;
      }
      if (text.startsWith("/steer ")) {
        if (!store.exists()) return;
        const payload = text.slice("/steer ".length).trim();
        store.queueInbox("steer", payload);
        transcript.addChild(new Text(`[queued steering] ${payload}`));
        tui.requestRender();
        return;
      }
      transcript.addChild(new Text(`unknown command: ${text}. Type /help for available commands.`));
      tui.requestRender();
      return;
    }

    if (activeGate) {
      const gate = activeGate;
      const field = gate.fields[gate.index];
      if (field) gate.values[field.key] = coerce(text);
      gate.index += 1;
      if (gate.index >= gate.fields.length) {
        activeGate = undefined;
        renderGatePrompt();
        refreshStatus("running");
        gate.resolve(gate.values);
      } else {
        renderGatePrompt();
      }
      tui.requestRender();
      return;
    }

    if (waitingForPrompt) {
      const resolve = waitingForPrompt;
      waitingForPrompt = undefined;
      transcript.addChild(userMessageComponent(text));
      refreshStatus("running");
      tui.requestRender();
      resolve(text);
      return;
    }

    if (!store.exists()) return;

    store.queueInbox("steer", text);
    transcript.addChild(new Text(`[queued steering] ${text}`));
    tui.requestRender();
  };

  // If a prompt was provided at startup, display it in the transcript
  if (options.start.kind === "run" && options.start.prompt) {
    transcript.addChild(userMessageComponent(options.start.prompt));
  }

  // A resumed session's own transcript summary
  if (options.start.kind === "resume" && store.exists()) {
    for (const turn of store.readMeta().turns) {
      const line = `${turn.activityId}  ${turn.harness ?? ""}  ${turn.summary ?? ""}`.trim();
      transcript.addChild(new Text(line));
      pushTrail(line);
    }
    refreshStatus();
  }

  options.onReady?.({ editor, root });

  tui.start();
  try {
    let promptToUse = options.start.kind === "run" ? options.start.prompt : undefined;
    if (options.start.kind === "run" && !promptToUse) {
      const xml = existsSync(options.start.graphPath) ? readFileSync(options.start.graphPath, "utf8") : "";
      const first = xml ? await firstActivity(xml) : undefined;
      if (first?.type !== "bpmn:UserTask") {
        refreshStatus("idle");
        promptToUse = await new Promise<string | undefined>((resolve) => {
          waitingForPrompt = resolve;
        });
        if (!promptToUse) {
          return { sessionId, outcome: "stopped", turns: 0 };
        }
      }
    }

    const shared = {
      paths: options.paths,
      project: options.project,
      model: options.model,
      systemPrompt: options.systemPrompt,
      streamFn: options.streamFn,
      tools: options.tools,
      signal: options.signal,
      onSessionReady: wireTranscript,
      onActivity: (activity: Parameters<NonNullable<RunSessionOptions["onActivity"]>>[0]) =>
        pushTrail(`${activity.activityId}  ${activity.harness}  ${activity.result.summary}`),
      onProgress: (line: string) => {
        if (line.trim().startsWith("note:")) pushTrail(line.trim());
        refreshStatus("running");
      },
      onWait,
    };
    const outcome =
      options.start.kind === "resume"
        ? await resumeSession({ ...shared, sessionId })
        : await runSession({
            ...shared,
            graphPath: options.start.graphPath,
            prompt: promptToUse,
            name: options.start.name,
            sessionId,
          });
    refreshStatus("idle");
    return outcome;
  } finally {
    if (studioServer) {
      void studioServer.close();
    }
    tui.renderNow(true);
    tui.stop();
  }
}
