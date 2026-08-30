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
import { runSession, type RunSessionOptions, type SessionOutcome } from "../agent/runner.ts";
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

export interface TuiAppOptions {
  paths: Paths;
  project: string;
  graphPath: string;
  /** For the status strip -- the `--graph` name, not the resolved file path. */
  graphLabel: string;
  prompt?: string;
  name?: string;
  model: RunSessionOptions["model"];
  modelLabel: string;
  systemPrompt: string;
  streamFn: RunSessionOptions["streamFn"];
  tools: ToolExecutor;
  /** Injectable so a test can drive the whole app against a fake, without a real pty. */
  terminal: Terminal;
  /** Fixed up front (rather than left to `runSession` to generate) so the status strip can report it from the first frame. */
  sessionId?: string;
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
  const sessionId = options.sessionId ?? randomUUID().slice(0, 8);
  const store = new SessionStore(options.paths, sessionId);
  const coerce = options.coerceValue ?? ((raw: string) => raw);
  const trailSize = options.trailSize ?? 5;

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
      statusText.setText(`graph ${options.graphLabel} · model ${options.modelLabel} · session ${sessionId} · starting…`);
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
      `graph ${options.graphLabel} · ${meta.turns.length} turn(s) · cache ${usage.cacheRead}/${usage.input} · ` +
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

  options.onReady?.({ editor, root });

  tui.start();
  try {
    // `runSession` calls `store.create()` synchronously before its first
    // `await`, so by the time this returns a pending promise the session
    // directory already exists -- the editor's `store.exists()` guard above
    // only ever matters for a keystroke that arrives before `runSession` is
    // even called, which cannot happen since `tui.start()` runs first.
    return await runSession({
      paths: options.paths,
      project: options.project,
      graphPath: options.graphPath,
      prompt: options.prompt,
      name: options.name,
      model: options.model,
      systemPrompt: options.systemPrompt,
      streamFn: options.streamFn,
      tools: options.tools,
      sessionId,
      signal: options.signal,
      onSessionReady: wireTranscript,
      onActivity: (activity) => pushTrail(`${activity.activityId}  ${activity.harness}  ${activity.result.summary}`),
      onProgress: (line) => {
        if (line.trim().startsWith("note:")) pushTrail(line.trim());
        refreshStatus();
      },
      onWait,
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
