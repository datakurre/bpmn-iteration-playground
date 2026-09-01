// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeScreen, RecordingTerminal } from "./recording-terminal.ts";

describe("RecordingTerminal", () => {
  it("reconstructs cursor movement and erased lines", () => {
    const terminal = new RecordingTerminal(12, 3);
    terminal.write("hello\nworld");
    terminal.write("\x1b[2;1H\x1b[2Kthere");
    expect(normalizeScreen(terminal.currentScreen())).toBe("hello\nthere");
    expect(terminal.frames()).toHaveLength(2);
  });

  it("replays input through the Terminal start callback", async () => {
    const terminal = new RecordingTerminal();
    const input: string[] = [];
    terminal.start((data) => input.push(data), () => {});
    terminal.enqueueInput("a", "b", "\r");
    await terminal.drainInput();
    expect(input).toEqual(["a", "b", "\r"]);
  });

  it("keeps a fixed screen after resize", () => {
    const terminal = new RecordingTerminal(5, 2);
    terminal.write("hello");
    terminal.resize(8, 3);
    expect(terminal.currentScreen()).toEqual(["hello", "", ""]);
  });
});
