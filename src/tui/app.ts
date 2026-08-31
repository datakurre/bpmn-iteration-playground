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
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { pendingGates } from "../agent/graph.ts";
import type { Paths } from "../agent/paths.ts";
import type { PiSession } from "../agent/pi-session.ts";
import { resumeSession, runSession, type RunSessionOptions, type SessionOutcome } from "../agent/runner.ts";
import { SessionStore } from "../agent/session-store.ts";
import type { ToolExecutor } from "../agent/tool-executor.ts";
import { formFields } from "./form-fields.ts";
import {
  assistantMessageComponent,
  CombinedAutocompleteProvider,
  Container,
  DynamicBorder,
  Editor,
  getSelectListTheme,
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
  const trailSize = options.trailSize ?? 5;
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
      { name: "model", description: "view active model" },
      { name: "graph", description: "view active graph workflow details" },
      { name: "sessions", description: "list recent sessions" },
      { name: "studio", description: "launch or open studio in browser" },
      { name: "steer", description: "queue a steering message before next turn", argumentHint: "<text>" },
      { name: "follow", description: "queue a follow-up message when agent finishes", argumentHint: "<text>" },
      { name: "clear", description: "clear current transcript screen" },
      { name: "help", description: "show help and keybindings" },
      { name: "exit", description: "quit the session" },
    ],
    options.project,
  );
  editor.setAutocompleteProvider(autocompleteProvider);

  const root = new Container();
  root.addChild(transcript);
  root.addChild(new DynamicBorder());
  root.addChild(trailText);
  root.addChild(new DynamicBorder());
  root.addChild(gateText);
  root.addChild(editor);
  root.addChild(statusText);
  tui.addChild(root);
  tui.setFocus(editor);

  const trail: string[] = [];
  let activeGate: GateWizard | undefined;

  function refreshStatus(state: "running" | "idle" | "waiting" = "running"): void {
    if (!store.exists()) {
      statusText.setText(`graph ${graphLabel} · model ${options.modelLabel} · session ${sessionId} · starting…`);
      tui.requestRender();
      return;
    }
    const meta = store.readMeta();
    const usage = meta.turns.reduce(
      (acc, turn) => ({
        input: acc.input + (turn.usage?.input ?? 0),
        cacheRead: acc.cacheRead + (turn.usage?.cacheRead ?? 0),
      }),
      { input: 0, cacheRead: 0 },
    );
    const at = meta.tokens.length > 0 ? meta.tokens.join(", ") : "-";
    const statePrefix = state === "idle" ? "idle · " : state === "waiting" ? "waiting · " : "";
    const cacheHit = usage.input > 0 ? ` (${Math.round((usage.cacheRead / usage.input) * 100)}%)` : "";
    statusText.setText(
      `${statePrefix}graph ${graphLabel} · ${meta.turns.length} turn(s) · cache ${usage.cacheRead}/${usage.input}${cacheHit} · ` +
        `revision ${Math.max(meta.revisions.length - 1, 0)} · at ${at} · session ${sessionId}`,
    );
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
      field ? `waiting on ${activeGate.activityId} — ${field.label} (${field.key}): ` : "",
    );
  }

  function wireTranscript(pi: PiSession): void {
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
    return new Promise((resolve) => {
      activeGate = { activityId, fields, index: 0, values: {}, resolve };
      renderGatePrompt();
      refreshStatus("waiting");
      tui.requestRender();
    });
  }

  editor.onSubmit = (raw: string) => {
    const text = raw.trim();
    editor.setText("");
    if (!text) return;

    if (text === "/help") {
      transcript.addChild(
        new Text(
          [
            "Commands:",
            "  /model           view active model",
            "  /graph           view active graph workflow details",
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

    if (text === "/model") {
      transcript.addChild(new Text(`model: ${options.modelLabel}`));
      tui.requestRender();
      return;
    }

    if (text === "/graph") {
      transcript.addChild(new Text(`graph: ${graphLabel}`));
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

    if (!store.exists()) return;

    if (text.startsWith("/follow ")) {
      store.queueInbox("follow-up", text.slice("/follow ".length));
      transcript.addChild(new Text(`[queued follow-up] ${text.slice("/follow ".length)}`));
    } else if (text.startsWith("/steer ")) {
      store.queueInbox("steer", text.slice("/steer ".length));
      transcript.addChild(new Text(`[queued steering] ${text.slice("/steer ".length)}`));
    } else {
      store.queueInbox("steer", text);
      transcript.addChild(new Text(`[queued steering] ${text}`));
    }
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
            prompt: options.start.prompt,
            name: options.start.name,
            sessionId,
          });
    refreshStatus("idle");
    return outcome;
  } finally {
    tui.renderNow(true);
    tui.stop();
  }
}
