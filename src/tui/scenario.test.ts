// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNoopToolExecutor } from "../agent/tool-executor.ts";
import { ensurePaths, paths } from "../agent/paths.ts";
import { dryRunModel } from "../cli/model.ts";
import { runTuiScenario } from "./scenario.ts";

it("runs a deterministic TUI scenario and captures the final screen", async () => {
  const home = mkdtempSync(join(tmpdir(), "graph-agent-tui-scenario-"));
  const model = dryRunModel();
  const result = await runTuiScenario({
    paths: ensurePaths(paths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") })),
    project: home,
    start: {
      kind: "run",
      graphPath: join(process.cwd(), "workflows", "pi-default-loop.bpmn"),
      graphLabel: "pi-default-loop",
      prompt: "scenario prompt",
    },
    model: model.model,
    modelLabel: model.label,
    systemPrompt: "",
    streamFn: model.streamFn,
    tools: createNoopToolExecutor([]),
    actions: [{ type: "waitFor", text: "idle · graph pi-default-loop" }],
  });

  expect(result.outcome.outcome).toBe("completed");
  expect(result.finalScreen.join("\n")).toContain("scenario prompt");
  expect(result.frames.length).toBeGreaterThan(0);
});
