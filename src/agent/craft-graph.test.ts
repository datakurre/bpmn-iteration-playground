// @vitest-environment node
/**
 * session-skeleton.bpmn -> craft_graph, the crafting flow a session's `craft`
 * callActivity is meant to run (see issue #12).
 *
 * Three bugs stacked up to make this "not exercised end to end":
 *  1. craft-graph.bpmn's layout_fragment/lint_fragment activities had no
 *     zeebe:input mapping for `fragment`, so the drafted text never reached
 *     graph:layout/graph:lint at all. Fixed on this branch.
 *  2. zeebe:ioMapping on a plain userTask (await_intent, review_fragment) was
 *     never applied -- only harness-backed service tasks got resolveOutput
 *     -- so `session_done` never became true and gw_more looped forever.
 *     Fixed on this branch (engine.ts's activity.end listener).
 *  3. A callActivity's called process runs as a genuinely separate
 *     bpmn-elements process instance with its own, isolated Environment:
 *     Environment.clone() (used when bpmn-elements spawns it) does not
 *     carry `output` by reference the way an activity clone within one
 *     process does, and neither `craft`'s callActivity nor this engine
 *     apply any zeebe:ioMapping across that boundary. So `intent` never
 *     reaches craft_graph's draft_fragment. Still open.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { indexLibrary, linkGraph } from "./link.ts";
import { bundledWorkflowsDir, listBpmnFiles, ensurePaths, paths as resolvePaths, type Paths } from "./paths.ts";
import { runGraph } from "./engine.ts";
import { runSession, type RunSessionOptions } from "./runner.ts";
import { createNoopToolExecutor } from "./tool-executor.ts";
import { ok } from "./harness.ts";

async function linkedSessionSkeleton(): Promise<string> {
  const files = listBpmnFiles(bundledWorkflowsDir()).map((f) => ({ source: f.path, xml: readFileSync(f.path, "utf8") }));
  const index = await indexLibrary(files);
  const source = readFileSync(join(bundledWorkflowsDir(), "session-skeleton.bpmn"), "utf8");
  return (await linkGraph(source, index)).xml;
}

describe("linking session-skeleton", () => {
  it("resolves the callActivity's craft_graph into the same definitions", async () => {
    const files = listBpmnFiles(bundledWorkflowsDir()).map((f) => ({ source: f.path, xml: readFileSync(f.path, "utf8") }));
    const index = await indexLibrary(files);
    const source = readFileSync(join(bundledWorkflowsDir(), "session-skeleton.bpmn"), "utf8");
    const result = await linkGraph(source, index);
    expect(result.linked).toContain("craft_graph");
    expect(result.dynamic).toEqual([]);
  });
});

describe("running the linked graph (mock harnesses, matching the real contract)", () => {
  it("routes through the callActivity to a rejected draft without hanging", async () => {
    const xml = await linkedSessionSkeleton();
    const seen: string[] = [];
    const waited: string[] = [];

    const result = await runGraph(xml, {
      harnesses: {
        "agent:turn": async () => {
          seen.push("agent:turn");
          return ok("drafted", { text: "not valid bpmn" });
        },
        "graph:layout": async (context) => {
          seen.push("graph:layout");
          return ok("laid out", { fragment: context.input.fragment });
        },
        "graph:lint": async () => {
          seen.push("graph:lint");
          return ok("lint result", { status: "failed", summary: "invalid", attempt: 3 });
        },
        "graph:extend": async () => {
          seen.push("graph:extend");
          return ok("extended", {});
        },
      },
      onWait: (activityId) => {
        waited.push(activityId);
        if (activityId === "await_intent") return { intent: "add a shell step", context: "", done: true };
        return undefined;
      },
    });

    // lint_exhausted fires on attempt 3 without ever needing a human review --
    // the mock always reports "failed", so craft_rejected ends the callActivity.
    expect(seen).toEqual(["agent:turn", "graph:layout", "graph:lint"]);
    expect(waited).toEqual(["await_intent"]);
    expect(result.outcome).toBe("completed");
  });

  it("routes through review, apply, and back into the session on approval", async () => {
    const xml = await linkedSessionSkeleton();
    const seen: string[] = [];
    const waited: string[] = [];

    const result = await runGraph(xml, {
      harnesses: {
        "agent:turn": async () => {
          seen.push("agent:turn");
          return ok("drafted", { text: "a fragment" });
        },
        "graph:layout": async (context) => {
          seen.push("graph:layout");
          return ok("laid out", { fragment: context.input.fragment });
        },
        "graph:lint": async () => {
          seen.push("graph:lint");
          return ok("lint result", { status: "success", summary: "looks fine", attempt: 1 });
        },
        "graph:extend": async () => {
          seen.push("graph:extend");
          return ok("extended", { status: "success" });
        },
      },
      onWait: (activityId) => {
        waited.push(activityId);
        if (activityId === "await_intent") return { intent: "add a shell step", context: "", done: true };
        if (activityId === "review_fragment") return { approval: "apply", notes: "looks good" };
        return undefined;
      },
    });

    expect(seen).toEqual(["agent:turn", "graph:layout", "graph:lint", "graph:extend"]);
    expect(waited).toEqual(["await_intent", "review_fragment"]);
    expect(result.outcome).toBe("completed");
  });
});

describe("running the linked graph with the real harness registry", () => {
  // Not yet: the callActivity spawns craft_graph as a genuinely separate
  // bpmn-elements process with an isolated Environment, so `intent` (set by
  // await_intent, a plain userTask in the *session* process) never reaches
  // draft_fragment inside craft_graph. See the module docblock and issue #12.
  // Once callActivity gets its own zeebe:ioMapping applied across that
  // boundary, delete `.fails` here -- this is meant to start passing.
  it.fails("carries the session's intent into the crafting graph's first turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-craft-"));
    const paths: Paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("a fragment")], { stopReason: "stop" })] as never);

    const progress: string[] = [];
    await runSession({
      paths,
      project: "/tmp/some-project",
      graphPath: join(bundledWorkflowsDir(), "session-skeleton.bpmn"),
      model: faux.getModel(),
      systemPrompt: "test agent",
      streamFn: ((m: never, context: never, o: never) => faux.provider.streamSimple(m, context, o)) as RunSessionOptions["streamFn"],
      tools: createNoopToolExecutor(["read", "bash"]),
      onProgress: (line) => progress.push(line),
      onWait: (activityId) => {
        if (activityId === "await_intent") return { intent: "add a shell verification step", context: "", done: true };
        if (activityId === "review_fragment") return { approval: "reject", notes: "" };
        return undefined;
      },
    });

    // Today draft_fragment sees no `prompt` at all -- session-skeleton's
    // `intent` never crosses the callActivity boundary into craft_graph.
    expect(progress.some((line) => line.includes("starts a turn with nothing to say"))).toBe(false);
  }, 15000);
});
