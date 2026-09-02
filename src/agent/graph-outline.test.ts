// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { graphOutline } from "./graph.ts";

describe("graphOutline", () => {
  it("renders an outline for pi-default-loop.bpmn", async () => {
    const xml = readFileSync(join(process.cwd(), "workflows", "pi-default-loop.bpmn"), "utf8");
    const outline = await graphOutline(xml, {
      visited: ["loop_start", "inject_pending", "llm_turn"],
      tokens: ["gw_tools"],
    });

    expect(outline).toContain("· start (Prompt)");
    expect(outline).toContain("·    └─ inject_pending  agent:steer");
    expect(outline).toContain("·       └─ llm_turn  agent:turn");
    expect(outline).toContain("●                └─ ◆ gw_tools (Tool calls?)");
    expect(outline).toContain("↺ gw_inject_entry");
    expect(outline).toContain("drain_followup  agent:follow-up");
    expect(outline).toContain("◉ end_done (Agent done)");
  });

  it("renders an outline for session-default.bpmn", async () => {
    const xml = readFileSync(join(process.cwd(), "workflows", "session-default.bpmn"), "utf8");
    const outline = await graphOutline(xml);

    expect(outline).toContain("start (Prompt)");
    expect(outline).toContain("agent_loop  [call: pi_default_loop]");
    expect(outline).toContain("◉ session_end (Done)");
  });

  it("renders an outline for session-skeleton.bpmn with UserTasks and gates", async () => {
    const xml = readFileSync(join(process.cwd(), "workflows", "session-skeleton.bpmn"), "utf8");
    const outline = await graphOutline(xml, { tokens: ["await_intent"] });

    expect(outline).toContain("●    └─ await_intent  [UserTask: What should the agent do?]");
    expect(outline).toContain("craft  [call: craft_graph]");
    expect(outline).toContain("◉ session_end (Session ended)");
  });

  it("renders an outline for shell-demo.bpmn", async () => {
    const xml = readFileSync(join(process.cwd(), "workflows", "shell-demo.bpmn"), "utf8");
    const outline = await graphOutline(xml);

    expect(outline).toContain("start (Prompt)");
    expect(outline).toContain("turn  agent:turn");
    expect(outline).toContain("verify  shell");
    expect(outline).toContain("◉ end_verified (Verified)");
  });
});
