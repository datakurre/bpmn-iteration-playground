import type { SessionOutcome } from "../agent/runner.ts";
import { startTui, type TuiAppOptions, type TuiHandles } from "./app.ts";
import { normalizeScreen, RecordingTerminal, type TerminalFrame } from "./recording-terminal.ts";
import { stripTerminalSequences } from "./pi-bridge.ts";

export type TuiAction =
  | { type: "keys"; data: string }
  | { type: "submit"; text: string }
  | { type: "waitFor"; text: string; timeoutMs?: number }
  | { type: "wait"; milliseconds: number }
  | { type: "resize"; columns: number; rows: number };

export interface TuiScenarioOptions extends Omit<TuiAppOptions, "terminal"> {
  terminal?: RecordingTerminal;
  actions: TuiAction[];
  timeoutMs?: number;
}

export interface TuiScenarioResult {
  outcome: SessionOutcome;
  frames: readonly TerminalFrame[];
  finalScreen: string[];
  rawAnsi: string;
}

export async function runTuiScenario(options: TuiScenarioOptions): Promise<TuiScenarioResult> {
  const terminal = options.terminal ?? new RecordingTerminal();
  let handles: TuiHandles | undefined;
  const ready = new Promise<void>((resolve) => {
    const original = options.onReady;
    options.onReady = (readyHandles) => {
      handles = readyHandles;
      original?.(readyHandles);
      resolve();
    };
  });
  const outcomePromise = startTui({ ...options, terminal });
  await ready;
  for (const action of options.actions) {
    if (action.type === "keys") terminal.enqueueInput(action.data);
    if (!handles) throw new Error("TUI did not become ready");
    if (action.type === "submit") handles.editor.onSubmit?.(action.text);
    if (action.type === "resize") terminal.resize(action.columns, action.rows);
    if (action.type === "wait") await new Promise((resolve) => setTimeout(resolve, action.milliseconds));
    if (action.type === "waitFor") await waitForScreen(handles.root, terminal.columns, action.text, action.timeoutMs ?? options.timeoutMs ?? 5000);
  }
  const outcome = await withTimeout(outcomePromise, options.timeoutMs ?? 10000, terminal);
  const finalScreen = handles?.root.render(terminal.columns).map(stripTerminalSequences) ?? terminal.currentScreen();
  return { outcome, frames: terminal.frames(), finalScreen, rawAnsi: terminal.rawOutput() };
}

async function waitForScreen(root: { render(width: number): string[] }, width: number, text: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!normalizeScreen(root.render(width)).includes(text)) {
    if (Date.now() - started > timeoutMs) throw new Error(`TUI did not render ${JSON.stringify(text)}\n\n${normalizeScreen(root.render(width))}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, terminal: RecordingTerminal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TUI scenario timed out\n\n${normalizeScreen(terminal.currentScreen())}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
