/**
 * The single seam between `graph-agent tui` and Pi's own UI components.
 *
 * `docs/research/06-tui.md` recommends reusing `AssistantMessageComponent`/
 * `ToolExecutionComponent` "a la carte" rather than embedding Pi's
 * `InteractiveMode` (which owns its own loop -- exactly the thing this
 * project has given to the diagram instead). Pi's exports are public API, but
 * this repo pins an exact version (`0.84.3`, not `^0.84.3`); every use of
 * those two components is routed through here so a version bump that breaks
 * a constructor signature fails to typecheck in one file, and the fallback --
 * render the message as plain text -- lives in exactly one place too.
 */
import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  stripTerminalSequences,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type SelectItem,
  type SlashCommand,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  UserMessageComponent,
  DynamicBorder,
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// `AssistantMessageComponent`/`ToolExecutionComponent` read Pi's own global
// theme singleton lazily, at *render* time rather than construction --
// markdown with a code block throws "Theme not initialized" the first time
// anything tries to render one, since Pi's own `InteractiveMode` is what
// normally calls this and this project never embeds that. One idempotent
// call, made as soon as this module is loaded (i.e. before `graph-agent tui`
// builds anything), is enough for the whole process.
initTheme();

/**
 * Wraps a Pi component so a throw during `.render()` -- not just at
 * construction, which is all a plain try/catch around `new
 * AssistantMessageComponent(...)` would guard -- falls back to plain text
 * instead of taking the whole TUI down. `render()` runs on every frame, so
 * this is the version-drift guard `docs/research/06-tui.md` asks for
 * applied where it actually needs to hold.
 */
class SafeRender implements Component {
  constructor(
    private readonly inner: Component,
    private readonly fallback: () => string,
  ) {}
  invalidate(): void {
    try {
      this.inner.invalidate();
    } catch {
      // Best-effort; a broken invalidate() does not block the next render's own fallback.
    }
  }
  render(width: number): string[] {
    try {
      return this.inner.render(width);
    } catch {
      return new Text(this.fallback()).render(width);
    }
  }
}

/** Plain-text fallback for an assistant message, used if the real component throws. */
function assistantText(message: AssistantMessage): string {
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text || `(assistant: ${message.stopReason ?? "stop"})`;
}

/** Render one finished assistant message for the transcript. */
export function assistantMessageComponent(message: AssistantMessage): Component {
  try {
    return new SafeRender(new AssistantMessageComponent(message, false, getMarkdownTheme()), () => assistantText(message));
  } catch {
    return new Text(assistantText(message));
  }
}

export interface StreamingAssistantEntry {
  component: Component;
  update(message: AssistantMessage, isStreaming?: boolean): void;
}

/** A live streaming assistant message in the transcript: created on message_start, updated on message_update. */
export function streamingAssistantComponent(initialMessage?: AssistantMessage): StreamingAssistantEntry {
  try {
    const inner = new AssistantMessageComponent(initialMessage, false, getMarkdownTheme());
    return {
      component: new SafeRender(inner, () => (initialMessage ? assistantText(initialMessage) : "")),
      update: (msg, isStreaming = true) => {
        try {
          inner.updateContent(msg, isStreaming);
        } catch {
          // Fallback if render throws
        }
      },
    };
  } catch {
    const text = new Text(initialMessage ? assistantText(initialMessage) : "");
    return {
      component: text,
      update: (msg) => text.setText(assistantText(msg)),
    };
  }
}

/** Render one user message for the transcript. */
export function userMessageComponent(text: string): Component {
  try {
    return new SafeRender(new UserMessageComponent(text, getMarkdownTheme()), () => `> ${text}`);
  } catch {
    return new Text(`> ${text}`);
  }
}

export interface ToolResultLike {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
}

/** A live tool-call entry in the transcript: created on `tool_execution_start`, settled on `_end`. */
export interface ToolTranscriptEntry {
  component: Component;
  setResult(result: ToolResultLike): void;
}

function summarizeArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

function summarizeResult(result: ToolResultLike): string {
  const text = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return `${result.isError ? "failed" : "ok"}${text ? `\n${text}` : ""}`;
}

/**
 * `ToolExecutionComponent` wants a live `TUI` (it calls `ui.requestRender()`
 * on every update) and a working directory to resolve its built-in
 * renderers against -- the running `TUI` itself and the session's project
 * dir satisfy both.
 */
export function toolTranscriptEntry(
  toolName: string,
  toolCallId: string,
  args: unknown,
  ui: TUI,
  cwd: string,
): ToolTranscriptEntry {
  try {
    const component = new ToolExecutionComponent(toolName, toolCallId, args, { showImages: false }, undefined, ui, cwd);
    component.markExecutionStarted();
    return {
      component: new SafeRender(component, () => `${toolName}(${summarizeArgs(args)})`),
      setResult: (result) => component.updateResult({ content: result.content, isError: result.isError }),
    };
  } catch {
    const text = new Text(`${toolName}(${summarizeArgs(args)})`);
    return {
      component: text,
      setResult: (result) => text.setText(`${toolName}(${summarizeArgs(args)}) -> ${summarizeResult(result)}`),
    };
  }
}

export {
  Box,
  CombinedAutocompleteProvider,
  Container,
  DynamicBorder,
  Editor,
  getMarkdownTheme,
  getSelectListTheme,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type SelectItem,
  type SlashCommand,
  type Terminal,
  type TUI,
  stripTerminalSequences,
};
