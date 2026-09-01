import { join } from "node:path";
import { ensurePaths, paths as resolvePaths } from "../agent/paths.ts";
import { dryRunModel } from "../cli/model.ts";
import { createNoopToolExecutor } from "../agent/tool-executor.ts";
import { runTuiScenario } from "./scenario.ts";
import { RecordingTerminal, normalizeScreen } from "./recording-terminal.ts";

export async function captureTui(): Promise<{ screen: string; ansi: string }> {
  const model = dryRunModel();
  const terminal = new RecordingTerminal(80, 24);
  const result = await runTuiScenario({
    paths: ensurePaths(resolvePaths(process.env)),
    project: process.cwd(),
    start: { kind: "run", graphPath: join(process.cwd(), "workflows", "pi-default-loop.bpmn"), graphLabel: "pi-default-loop", prompt: "Show the deterministic TUI showcase." },
    model: model.model,
    modelLabel: model.label,
    systemPrompt: "",
    streamFn: model.streamFn,
    tools: createNoopToolExecutor([]),
    terminal,
    actions: [{ type: "wait", milliseconds: 100 }],
  });
  return {
    screen: normalizeScreen(result.finalScreen).replace(/session [a-z0-9-]+/g, "session showcase"),
    ansi: result.rawAnsi.replace(/session [a-z0-9-]+/g, "session showcase"),
  };
}
