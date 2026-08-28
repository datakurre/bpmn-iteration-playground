// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runSession, resumeSession, type RunSessionOptions } from "./runner.ts";
import { SessionStore } from "./session-store.ts";
import { createNoopToolExecutor } from "./tool-executor.ts";
import { ensurePaths, paths as resolvePaths, type Paths } from "./paths.ts";
import { bundledWorkflowsDir } from "./paths.ts";

let home: string;
let paths: Paths;
const project = "/tmp/some-project";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "graph-agent-run-"));
  paths = ensurePaths(
    resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
  );
});

function scripted(responses: unknown[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  faux.setResponses(responses as never);
  return faux;
}

function options(faux: ReturnType<typeof scripted>, extra: Record<string, unknown> = {}) {
  return {
    paths,
    project,
    graphPath: join(bundledWorkflowsDir(), "pi-default-loop.bpmn"),
    model: faux.getModel(),
    systemPrompt: "test agent",
    streamFn: ((m: never, context: never, o: never) => faux.provider.streamSimple(m, context, o)) as RunSessionOptions["streamFn"],
    tools: createNoopToolExecutor(["read", "bash"]),
    ...extra,
  };
}

describe("runSession on the built-in loop", () => {
  it("runs a turn with no tool calls straight to the end", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("Nothing to do.")], { stopReason: "stop" })]);
    const result = await runSession(options(faux, { prompt: "say hello" }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(1);

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns[0]?.stopReason).toBe("stop");
    expect(detail.turns[0]?.summary).toBe("Nothing to do.");
    expect(detail.project).toBe(project);
  });

  it("drives the tool batch and comes back for another turn", async () => {
    const faux = scripted([
      fauxAssistantMessage([fauxText("Looking."), fauxToolCall("read", { path: "a.ts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("All done.")], { stopReason: "stop" }),
    ]);
    const result = await runSession(options(faux, { prompt: "read a.ts" }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    // one turn that called a tool, then one that finished
    expect(result.turns).toBe(2);

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns.map((t) => t.stopReason)).toEqual(["toolUse", "stop"]);
    expect(detail.turns[0]?.toolCalls).toEqual(["read"]);
    expect(detail.status).toBe("completed");
  });

  it("reads the later turn's prompt prefix from cache", async () => {
    // The whole reason one Pi session spans the session: turn two must not pay
    // for turn one's context again.
    const faux = scripted([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Done.")], { stopReason: "stop" }),
    ]);
    const result = await runSession(options(faux, { prompt: "read a.ts and summarise it for me" }));

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0]?.usage?.cacheRead).toBe(0);
    expect(detail.turns[1]?.usage?.cacheRead).toBeGreaterThan(0);
  });

  it("records a graph revision and the project it ran in", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("hi")], { stopReason: "stop" })]);
    const result = await runSession(options(faux, { prompt: "hi", name: "named run" }));

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.name).toBe("named run");
    expect(detail.revisions).toHaveLength(1);
    expect(detail.graph).toContain("pi_default_loop");
  });

  it("leaves no token behind on a completed run", async () => {
    // Token reports come from getPostponed() as the run proceeds, so the last
    // one seen is whatever was in flight. A finished run must not keep drawing a
    // token on the diagram.
    const faux = scripted([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
    const result = await runSession(options(faux, { prompt: "go" }));
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.tokens).toEqual([]);
    expect(detail.visited.length).toBeGreaterThan(0);
  });

  it("takes the failure branch when the model errors", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("")], { stopReason: "error" })]);
    const result = await runSession(options(faux, { prompt: "go" }));

    // the loop terminates on error rather than looping forever
    expect(result.outcome).toBe("completed");
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns[0]?.stopReason).toBe("error");
  });
});

describe("resumeSession", () => {
  it("refuses a session that was never run", () => {
    return expect(
      resumeSession({ ...options(scripted([])), sessionId: "nope" } as never),
    ).rejects.toThrow(/unknown session/);
  });
});
