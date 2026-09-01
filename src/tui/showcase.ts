import { join } from "node:path";
import { ensurePaths, paths as resolvePaths } from "../agent/paths.ts";
import { dryRunModel } from "../cli/model.ts";
import { createNoopToolExecutor } from "../agent/tool-executor.ts";
import { runTuiScenario } from "./scenario.ts";
import { RecordingTerminal } from "./recording-terminal.ts";

const model = dryRunModel();
const terminal = new RecordingTerminal(Number(process.env.TUI_COLUMNS ?? 80), Number(process.env.TUI_ROWS ?? 24));
const paths = ensurePaths(resolvePaths(process.env));
const graphPath = join(process.cwd(), "workflows", "" + (process.env.TUI_GRAPH ?? "pi-default-loop") + ".bpmn");
const result = await runTuiScenario({
  paths,
  project: process.cwd(),
  start: { kind: "run", graphPath, graphLabel: process.env.TUI_GRAPH ?? "pi-default-loop", prompt: "Show the deterministic TUI showcase." },
  model: model.model,
  modelLabel: model.label,
  systemPrompt: "",
  streamFn: model.streamFn,
  tools: createNoopToolExecutor([]),
  terminal,
  actions: [{ type: "wait", milliseconds: 100 }],
});

process.stdout.write(result.finalScreen.join("\n").replace(/session [a-z0-9-]+/g, "session showcase") + "\n");
