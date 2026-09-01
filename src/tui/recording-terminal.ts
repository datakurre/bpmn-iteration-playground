import type { Terminal } from "./pi-bridge.ts";

export interface TerminalFrame {
  index: number;
  columns: number;
  rows: number;
  ansi: string;
  screen: string[];
}

/** A small deterministic terminal used by tests and the TUI showcase. */
export class RecordingTerminal implements Terminal {
  private readonly buffer: string[][];
  private cursorRow = 0;
  private cursorColumn = 0;
  private savedCursor = { row: 0, column: 0 };
  private inputHandler?: (data: string) => void;
  private queue: string[] = [];
  private readonly recordedFrames: TerminalFrame[] = [];
  private output = "";
  private pending = "";

  constructor(public columns = 80, public rows = 24) {
    this.buffer = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "));
  }

  kittyProtocolActive = false;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.inputHandler = onInput;
  }

  stop(): void {
    this.inputHandler = undefined;
  }

  async drainInput(): Promise<void> {
    const pending = this.queue.splice(0);
    for (const data of pending) this.inputHandler?.(data);
  }

  write(data: string): void {
    this.output += data;
    this.consume(data);
    this.recordedFrames.push({
      index: this.recordedFrames.length,
      columns: this.columns,
      rows: this.rows,
      ansi: data,
      screen: this.currentScreen(),
    });
  }

  enqueueInput(...data: string[]): void {
    this.queue.push(...data);
    void this.drainInput();
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    while (this.buffer.length < rows) this.buffer.push(Array.from({ length: columns }, () => " "));
    for (const line of this.buffer) {
      while (line.length < columns) line.push(" ");
      line.length = columns;
    }
    this.buffer.length = rows;
    this.cursorRow = Math.min(this.cursorRow, rows - 1);
    this.cursorColumn = Math.min(this.cursorColumn, columns - 1);
  }

  frames(): readonly TerminalFrame[] {
    return this.recordedFrames;
  }

  rawOutput(): string {
    return this.output;
  }

  currentScreen(): string[] {
    return this.buffer.map((line) => line.join("").replace(/\s+$/, ""));
  }

  moveBy(lines: number): void {
    this.cursorRow = Math.max(0, Math.min(this.rows - 1, this.cursorRow + lines));
  }

  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void { this.eraseLine(0); }
  clearFromCursor(): void { this.eraseLine(this.cursorColumn); }
  clearScreen(): void {
    for (const line of this.buffer) line.fill(" ");
    this.cursorRow = 0;
    this.cursorColumn = 0;
  }
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}

  private consume(data: string): void {
    data = this.pending + data;
    this.pending = "";
    let index = 0;
    while (index < data.length) {
      const char = data[index]!;
      if (char === "\x1b" && data[index + 1] === "[") {
        const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(index));
        if (match) {
          this.consumeCsi(match[1] ?? "", match[2]!);
          index += match[0].length;
          continue;
        }
        if (index + 2 >= data.length || !/[A-Za-z]/.test(data.slice(index + 2))) break;
      }
      if (char === "\x1b") {
        if (data[index + 1] === "]") {
          const end = data.indexOf("\x07", index + 2);
          if (end === -1) break;
          index = end + 1;
        } else {
          index += 1;
        }
        continue;
      }
      if (char === "\n") this.cursorRow = Math.min(this.rows - 1, this.cursorRow + 1);
      else if (char === "\r") this.cursorColumn = 0;
      else if (char >= " ") {
        if (this.cursorColumn < this.columns) this.buffer[this.cursorRow]![this.cursorColumn] = char;
        this.cursorColumn += 1;
        if (this.cursorColumn >= this.columns) {
          this.cursorColumn = 0;
          this.cursorRow = Math.min(this.rows - 1, this.cursorRow + 1);
        }
      }
      index += 1;
    }
    this.pending = data.slice(index);
  }

  private consumeCsi(rawParams: string, command: string): void {
    const params = rawParams.replace(/^\?/, "").split(";").map((value) => Number(value) || 0);
    const count = (fallback: number) => (params[0] || fallback);
    switch (command) {
      case "A": this.cursorRow = Math.max(0, this.cursorRow - count(1)); break;
      case "B": this.cursorRow = Math.min(this.rows - 1, this.cursorRow + count(1)); break;
      case "C": this.cursorColumn = Math.min(this.columns - 1, this.cursorColumn + count(1)); break;
      case "D": this.cursorColumn = Math.max(0, this.cursorColumn - count(1)); break;
      case "G": this.cursorColumn = Math.max(0, Math.min(this.columns - 1, count(1) - 1)); break;
      case "H":
      case "f":
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, (params[0] || 1) - 1));
        this.cursorColumn = Math.max(0, Math.min(this.columns - 1, (params[1] || 1) - 1));
        break;
      case "J":
        if (params[0] === 2 || params[0] === 3) this.clearScreen();
        else for (let row = this.cursorRow; row < this.rows; row++) this.buffer[row]!.fill(" ");
        break;
      case "K": this.eraseLine(params[0] === 2 ? 0 : this.cursorColumn); break;
      case "s": this.savedCursor = { row: this.cursorRow, column: this.cursorColumn }; break;
      case "u": this.cursorRow = this.savedCursor.row; this.cursorColumn = this.savedCursor.column; break;
      case "m":
      case "h":
      case "l":
        break;
    }
  }

  private eraseLine(from: number): void {
    this.buffer[this.cursorRow]!.fill(" ", from);
  }
}

export function normalizeScreen(lines: readonly string[]): string {
  return lines.map((line) => line.trimEnd()).join("\n").trimEnd();
}
