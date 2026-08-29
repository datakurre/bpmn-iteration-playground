// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
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

    // the loop terminates rather than looping forever, and reports the failure
    // rather than looking like any other completed run (issue #18)
    expect(result.outcome).toBe("error");
    expect(result.error?.message).toContain("llm_turn");
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.status).toBe("error");
    expect(detail.turns[0]?.stopReason).toBe("error");
  });

  it("does not re-send the initial prompt once the transcript has a tool result (issue #25)", async () => {
    const faux = scripted([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);
    const userMessageCounts: number[] = [];
    const streamFn = ((m: never, context: never, o: never) => {
      const messages = (context as { messages: Array<{ role: string }> }).messages;
      userMessageCounts.push(messages.filter((message) => message.role === "user").length);
      return faux.provider.streamSimple(m, context, o);
    }) as RunSessionOptions["streamFn"];

    const result = await runSession(options(faux, { prompt: "run echo hi", streamFn }));

    expect(result.error).toBeUndefined();
    expect(result.turns).toBe(2);
    // Both requests saw exactly one user message: the loop's second llm_turn
    // continues the same transcript on the tool result rather than handing the
    // model its own original request again as a fresh one.
    expect(userMessageCounts).toEqual([1, 1]);
  });

  it("runs each call in a multi-call batch exactly once (issue #27)", async () => {
    const faux = scripted([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo A" }), fauxToolCall("bash", { command: "echo B" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);
    const ran: string[] = [];
    const tools = {
      list: () => [{ name: "bash", description: "Run a bash command.", parameters: { type: "object", additionalProperties: true } }],
      run: async (name: string, args: Record<string, unknown>) => {
        ran.push(`${name} ${JSON.stringify(args)}`);
        return { content: "ok" };
      },
    };

    const result = await runSession(options(faux, { prompt: "run two commands", tools }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(ran).toEqual(['bash {"command":"echo A"}', 'bash {"command":"echo B"}']);
  });
});

describe("callActivity into the shared library", () => {
  /** A caller and a callee that live in two different files, as they would. */
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

  const caller = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_caller" ${NS}>
  <bpmn:process id="caller" isExecutable="true">
    <bpmn:startEvent id="k_start"><bpmn:outgoing>kf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="kf1" sourceRef="k_start" targetRef="k_call" />
    <bpmn:callActivity id="k_call" name="Delegate" calledElement="helper">
      <bpmn:incoming>kf1</bpmn:incoming><bpmn:outgoing>kf2</bpmn:outgoing>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="kf2" sourceRef="k_call" targetRef="k_end" />
    <bpmn:endEvent id="k_end"><bpmn:incoming>kf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  const helper = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_helper" ${NS}>
  <bpmn:process id="helper" isExecutable="true">
    <bpmn:startEvent id="h_start"><bpmn:outgoing>hf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="hf1" sourceRef="h_start" targetRef="h_turn" />
    <bpmn:serviceTask id="h_turn" name="Helper turn">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping><zeebe:input source="=prompt" target="prompt" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>hf1</bpmn:incoming><bpmn:outgoing>hf2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="hf2" sourceRef="h_turn" targetRef="h_end" />
    <bpmn:endEvent id="h_end"><bpmn:incoming>hf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  function libraryWith(files: Record<string, string>): void {
    for (const [name, xml] of Object.entries(files)) {
      writeFileSync(join(paths.workflowsDir, name), xml);
    }
  }

  it("runs a process that lives in another file in the library", async () => {
    // bpmn-elements resolves calledElement only within one definition, so
    // without linking this call would park forever instead of running.
    libraryWith({ "caller.bpmn": caller, "helper.bpmn": helper });
    const faux = scripted([fauxAssistantMessage([fauxText("helped")], { stopReason: "stop" })]);
    const result = await runSession(
      options(faux, { graphPath: join(paths.workflowsDir, "caller.bpmn"), prompt: "delegate this" }),
    );

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");

    const detail = new SessionStore(paths, result.sessionId).detail();
    // the callee's own activity ran, so the call resolved across files
    expect(detail.visited).toContain("h_turn");
    expect(detail.turns[0]?.activityId).toBe("h_turn");
    expect(detail.revisions[0]?.reason).toMatch(/linked helper/);
  });

  it("stores the linked graph with the callee marked non-executable", async () => {
    // Left executable, the callee is auto-started as a top-level process as well
    // as being called, and its body runs twice.
    libraryWith({ "caller.bpmn": caller, "helper.bpmn": helper });
    const faux = scripted([fauxAssistantMessage([fauxText("helped")], { stopReason: "stop" })]);
    const result = await runSession(
      options(faux, { graphPath: join(paths.workflowsDir, "caller.bpmn"), prompt: "go" }),
    );

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.graph).toMatch(/<bpmn:process id="helper"[^>]*isExecutable="false"/);
    expect(detail.graph).toMatch(/<bpmn:process id="caller"[^>]*isExecutable="true"/);
    // the helper ran exactly once, not once as a root and once through the call
    expect(detail.turns).toHaveLength(1);
  });

  it("refuses to start when a calledElement is not in the library", async () => {
    libraryWith({ "caller.bpmn": caller });
    const faux = scripted([fauxAssistantMessage([fauxText("x")], { stopReason: "stop" })]);
    await expect(
      runSession(options(faux, { graphPath: join(paths.workflowsDir, "caller.bpmn"), prompt: "go" })),
    ).rejects.toThrow(/no graph in the library defines a process 'helper'/);
  });
});

describe("resumeSession", () => {
  it("refuses a session that was never run", () => {
    return expect(
      resumeSession({ ...options(scripted([])), sessionId: "nope" } as never),
    ).rejects.toThrow(/unknown session/);
  });
});
