// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runSession, resumeSession, graphOffersTools, type RunSessionOptions } from "./runner.ts";
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
    // Names the real, known fact (which turn's own stopReason was "error"
    // with no message) rather than the fabricated "llm_turn stopped: error"
    // this used to assert -- the engine itself never reported an error here,
    // it reached a plain terminate end event (issue #52).
    expect(result.error?.message).toContain("llm_turn");
    expect(result.error?.message).toContain('stopReason "error"');
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.status).toBe("error");
    expect(detail.turns[0]?.stopReason).toBe("error");
    expect(detail.harnessError).toBe(result.error?.message);
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

describe("graphOffersTools (issue #36)", () => {
  it("is true for a graph with an agent:tool activity, false for one without", () => {
    const withTools = readFileSync(join(bundledWorkflowsDir(), "pi-default-loop.bpmn"), "utf8");
    const withoutTools = readFileSync(join(bundledWorkflowsDir(), "craft-graph.bpmn"), "utf8");
    expect(graphOffersTools(withTools)).toBe(true);
    expect(graphOffersTools(withoutTools)).toBe(false);
  });
});

describe("a splice executes in the same run that drafted it (issue #45)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

  // draft (agent:turn) drafts a whole replacement definition, extend
  // (graph:extend) splices it in. Mirrors craft-graph.bpmn's own
  // draft_fragment -> apply_extension shape, minus the layout/lint/approval
  // steps this test does not need.
  const original = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_splice_test" ${NS}>
  <bpmn:process id="splice_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="extend" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  // What the model "drafts": same ids throughout (additive, per checkSplice),
  // but f3 now targets a new `marker` shell step before reaching `end`.
  const spliced = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_splice_test" ${NS}>
  <bpmn:process id="splice_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="extend" targetRef="marker" />
    <bpmn:serviceTask id="marker" name="Marker">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="shell" />
        <zeebe:taskHeaders>
          <zeebe:header key="command" value="echo spliced" />
        </zeebe:taskHeaders>
        <zeebe:ioMapping><zeebe:output source="=stdout" target="marker_output" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f4" sourceRef="marker" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  it("runs the spliced-in activity within the same run, not just the next resume", async () => {
    const graphPath = join(home, "splice_test.bpmn");
    writeFileSync(graphPath, original);
    const faux = scripted([fauxAssistantMessage([fauxText(spliced)], { stopReason: "stop" })]);

    // `shell`'s marker step needs a real cwd to spawn in -- the shared
    // `project` constant is a placeholder path that does not exist on disk.
    const result = await runSession(options(faux, { graphPath, project: home, prompt: "splice in a marker step" }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");

    const detail = new SessionStore(paths, result.sessionId).detail();
    // Before the fix, `marker` never ran in this run -- only a *subsequent*
    // `resume` would pick up the new revision and reach it.
    expect(detail.visited).toContain("marker");
    expect(detail.revisions.length).toBe(2);
  });

  it("bounds re-entry against a graph that never stops re-splicing", async () => {
    // draft -> extend loops back to draft unconditionally, with no end event
    // reachable at all; the "draft" turn re-echoes the graph verbatim each
    // time, which checkSplice accepts trivially (nothing added or removed).
    // Left unbounded, a splice-triggered stop that always re-enters would
    // spin this forever, one model turn per lap.
    const loopGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_loop_splice" ${NS}>
  <bpmn:process id="loop_splice" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:incoming>loop</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>loop</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="loop" sourceRef="extend" targetRef="draft" />
  </bpmn:process>
</bpmn:definitions>`;

    const graphPath = join(home, "loop_splice_test.bpmn");
    writeFileSync(graphPath, loopGraph);
    // The turn echoes back whatever graph it is handed -- always additive,
    // always accepted, always triggers another splice-forced stop.
    const faux = scripted(
      Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText(loopGraph)], { stopReason: "stop" })),
    );

    const result = await runSession(options(faux, { graphPath, prompt: "splice forever" }));

    // Settles rather than hanging (the test's own timeout would otherwise
    // catch that) and stops rather than completing, since the graph itself
    // has no end event this can ever reach.
    expect(result.outcome).toBe("stopped");
    expect(result.turns).toBeLessThanOrEqual(6);
  }, 10000);
});

describe("hang guard and phantom-running status (issue #52)", () => {
  it("resuming an already-completed session settles instead of hanging forever", async () => {
    // Reproduced against a real session: `graph-agent resume` on a session
    // that had already reached its own end event hung the whole CLI process
    // (an "unsettled top-level await", Node exit 13) because engine.resume()
    // dispatched nothing at all -- no activity, no wait, no end, no error --
    // so none of the three promises drive() raced ever settled.
    const faux = scripted([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
    const first = await runSession(options(faux, { prompt: "say hello", hangGuardMs: 50 }));
    expect(first.outcome).toBe("completed");

    const second = await resumeSession({
      ...options(scripted([]), { hangGuardMs: 50 }),
      sessionId: first.sessionId,
    });

    // Settles (the test itself would time out otherwise) as "stopped", with a
    // note explaining why, rather than hanging or claiming a bogus "completed".
    expect(second.outcome).toBe("stopped");

    const meta = new SessionStore(paths, first.sessionId).readMeta();
    expect(meta.status).not.toBe("running");
    expect(meta.pid).toBeUndefined();
    expect(meta.harnessError).toMatch(/dispatched nothing/);
  });

  it('never leaves status:"running" when resuming throws before the engine settles', async () => {
    // runSession's own linkGraph/appendGraph setup runs before drive() is ever
    // called, so a broken *graph* throws before status even becomes
    // "running" -- not the gap this guards. resumeSession's start() callback
    // (resumeGraph) is invoked from *inside* drive(), after status:"running"
    // is already written, so a state snapshot bpmn-elements' own recovery
    // cannot make sense of is what actually exercises the gap issue #52
    // found: nothing between such a throw and the ordinary return path wrote
    // a terminal status.
    const faux = scripted([fauxAssistantMessage([fauxText("hi")], { stopReason: "stop" })]);
    const first = await runSession(options(faux, { prompt: "hi", hangGuardMs: 50 }));
    expect(first.outcome).toBe("completed");

    const store = new SessionStore(paths, first.sessionId);
    store.writeEngineState({ nonsense: true, definitions: "not an array" });

    await expect(
      resumeSession({ ...options(scripted([]), { hangGuardMs: 50 }), sessionId: first.sessionId }),
    ).rejects.toThrow();

    const meta = store.readMeta();
    expect(meta.status).toBe("error");
    expect(meta.pid).toBeUndefined();
    expect(meta.harnessError).toBeDefined();
  });
});

describe("steering and follow-up queues (issue #48)", () => {
  it("a seeded follow-up drives a second outer iteration", async () => {
    // With no tool calls the agent would stop here -- pi-default-loop's own
    // drain_followup is exactly the seam that decides whether the outer loop
    // takes another lap. Before this fix nothing ever filled the queue it
    // drains, so gw_followup's has_followup branch was unreachable.
    const faux = scripted([
      fauxAssistantMessage([fauxText("first turn done")], { stopReason: "stop" }),
      fauxAssistantMessage([fauxText("second turn done")], { stopReason: "stop" }),
    ]);

    const result = await runSession(options(faux, { prompt: "go", followUp: ["now write a test"] }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(2);
  });

  it("a seeded steering message is injected before the next turn", async () => {
    // agent:steer calls pi.steer() for each queued message; the only
    // observable effect from outside PiSession is that the next turn's
    // request transcript carries it as an extra user message.
    const faux = scripted([fauxAssistantMessage([fauxText("ok")], { stopReason: "stop" })]);
    let sawSteerMessage = false;
    const streamFn = ((m: never, context: never, o: never) => {
      const messages = (context as { messages: Array<{ role: string; content?: unknown }> }).messages;
      sawSteerMessage ||= messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content).includes("focus on tests"),
      );
      return faux.provider.streamSimple(m, context, o);
    }) as RunSessionOptions["streamFn"];

    const result = await runSession(options(faux, { prompt: "go", steering: ["focus on tests"], streamFn }));

    expect(result.error).toBeUndefined();
    expect(sawSteerMessage).toBe(true);
  });

  it("graph-agent steer/follow-up queue into a session's inbox, drained by the running graph", async () => {
    // The out-of-band seam: a message queued into inbox.jsonl from outside
    // the process driving the session (SessionStore.queueInbox, what the CLI
    // commands write to) reaches the graph the same way a seeded one does.
    const faux = scripted([
      fauxAssistantMessage([fauxText("first turn done")], { stopReason: "stop" }),
      fauxAssistantMessage([fauxText("second turn done")], { stopReason: "stop" }),
    ]);
    const sessionId = "inbox-session";
    const store = new SessionStore(paths, sessionId);
    store.create(project);
    store.queueInbox("follow-up", "queued from another terminal");

    const result = await runSession({ ...options(faux, { prompt: "go" }), sessionId });

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(2);
    // Drained, not left behind for the next run to see again.
    expect(store.drainInbox("follow-up")).toEqual([]);
  });
});
