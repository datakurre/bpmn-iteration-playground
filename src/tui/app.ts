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
  Container,
  Editor,
  Text,
  toolTranscriptEntry,
  TuiMainScreen,
  type Component,
  type Terminal,
  type ToolTranscriptEntry,
} from "./pi-bridge.ts";

/**
 * What the TUI attaches to: a fresh session from a graph, or an existing one
 * to reattach to -- the only two entry points `runSession`/`resumeSession`
 * themselves offer. Everything downstream of the run (the transcript, the
 * trail, the status strip, the gate wizard) is driven by callbacks both
 * already provide identically, so this discriminant is the only place the
 * two paths actually diverge (issue #67).
 */
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
  /**
   * Test seam: called once the editor and layout exist, before the run
   * starts. `root.render(width)` gives a smoke test the same lines a real
   * terminal would see, and `editor.onSubmit` lets it "type" an answer
   * without simulating raw terminal escape sequences -- those belong to
   * pi-tui's own `Editor`, not to anything this project owns or should
   * re-test (issue #50).
   */
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

const RULE = "─".repeat(60);

/** Runs `graph-agent tui` end to end and resolves once the session settles (an end event, or a genuine stop). */
export async function startTui(options: TuiAppOptions): Promise<SessionOutcome> {
  const sessionId = options.start.kind === "resume" ? options.start.sessionId : randomUUID().slice(0, 8);
  const store = new SessionStore(options.paths, sessionId);
  const coerce = options.coerceValue ?? ((raw: string) => raw);
  const trailSize = options.trailSize ?? 5;
  const graphLabel = options.start.kind === "run" ? options.start.graphLabel : "(resumed)";

  const tui = new TuiMainScreen(options.terminal);
  const transcript = new Container();
  const trailText = new Text("");
  const gateText = new Text("");
  const statusText = new Text("");
  const editorTheme = {
    borderColor: (text: string) => text,
    selectList: {
      selectedPrefix: (text: string) => text,
      selectedText: (text: string) => text,
      description: (text: string) => text,
      scrollInfo: (text: string) => text,
      noMatch: (text: string) => text,
    },
  };
  const editor = new Editor(tui, editorTheme);
  const root = new Container();
  root.addChild(transcript);
  root.addChild(new Text(RULE));
  root.addChild(trailText);
  root.addChild(new Text(RULE));
  root.addChild(gateText);
  root.addChild(editor);
  root.addChild(statusText);
  tui.addChild(root);
  tui.setFocus(editor);

  const trail: string[] = [];
  let activeGate: GateWizard | undefined;

  function refreshStatus(): void {
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
    statusText.setText(
      `graph ${graphLabel} · ${meta.turns.length} turn(s) · cache ${usage.cacheRead}/${usage.input} · ` +
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
    pi.agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        transcript.addChild(assistantMessageComponent(event.message as AssistantMessage));
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
      tui.requestRender();
    });
  }

  editor.onSubmit = (raw: string) => {
    const text = raw.trim();
    editor.setText("");
    if (!text) return;

    if (activeGate) {
      const gate = activeGate;
      const field = gate.fields[gate.index];
      if (field) gate.values[field.key] = coerce(text);
      gate.index += 1;
      if (gate.index >= gate.fields.length) {
        activeGate = undefined;
        renderGatePrompt();
        gate.resolve(gate.values);
      } else {
        renderGatePrompt();
      }
      tui.requestRender();
      return;
    }

    if (!store.exists()) return; // Nothing to queue into yet -- see the ordering note below.
    if (text.startsWith("/follow ")) store.queueInbox("follow-up", text.slice("/follow ".length));
    else if (text.startsWith("/steer ")) store.queueInbox("steer", text.slice("/steer ".length));
    else store.queueInbox("steer", text);
    tui.requestRender();
  };

  // A resumed session's own transcript is not something Pi restores across a
  // fresh process -- only the graph's own state (meta.turns, the activity
  // trail) survives a process restart at all -- so this is a summary of what
  // already happened, built from the same `TurnRecord`s the status strip's
  // usage totals come from, not a replay of the original rich messages
  // (issue #67). Seeded before `onReady`/`tui.start()` so a headless test can
  // see it in the very first frame, the same as a real reattach would.
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
    // `runSession`/`resumeSession` call `store.create()`/require the store to
    // already exist synchronously before their first `await`, so by the time
    // either returns a pending promise the session directory is settled --
    // the editor's `store.exists()` guard above only ever matters for a
    // keystroke that arrives before that call is even made, which cannot
    // happen since `tui.start()` runs first.
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
        refreshStatus();
      },
      onWait,
    };
    return options.start.kind === "resume"
      ? await resumeSession({ ...shared, sessionId })
      : await runSession({
          ...shared,
          graphPath: options.start.graphPath,
          prompt: options.start.prompt,
          name: options.start.name,
          sessionId,
        });
  } finally {
    // `requestRender()` debounces: a run that settles inside that window (a
    // single fast real-model turn easily does) can leave its last frame --
    // the final assistant message, the last trail entry, the completed
    // status line -- only *scheduled*, never actually flushed, if `stop()`
    // tears the screen down before the debounce timer fires. A forced,
    // synchronous render first is the only way the terminal ends up showing
    // what actually happened rather than whatever the last flushed frame
    // was moments before it did.
    tui.renderNow(true);
    tui.stop();
  }
}
