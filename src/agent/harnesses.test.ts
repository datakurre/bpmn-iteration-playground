// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createHarnesses, type HarnessDeps } from "./harnesses.ts";
import type { HarnessContext } from "./harness.ts";
import { SessionStore } from "./session-store.ts";
import { ensurePaths, paths as resolvePaths } from "./paths.ts";
import { PiSession } from "./pi-session.ts";

function context(properties: Record<string, string>): HarnessContext {
  return { activityId: "run_it", harness: "shell", properties, input: {}, variables: {} };
}

/** The shell harness never touches pi/tools/store, so those can stay empty stubs. */
function shellHarness(cwd?: string) {
  const deps = {
    pi: {} as HarnessDeps["pi"],
    tools: {} as HarnessDeps["tools"],
    store: {} as HarnessDeps["store"],
    getGraph: () => "",
    setGraph: () => {},
    takeSteering: () => [],
    takeFollowUp: () => [],
    ...(cwd === undefined ? {} : { cwd }),
  };
  const harness = createHarnesses(deps).shell;
  if (!harness) throw new Error("no 'shell' harness registered");
  return harness;
}

describe("shell harness", () => {
  it("runs the command and reports a zero exit as success", async () => {
    const result = await shellHarness()(context({ command: "echo hi" }));
    expect(result.status).toBe("success");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("fails the activity on a non-zero exit by default", async () => {
    const result = await shellHarness()(context({ command: "exit 3" }));
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(3);
  });

  it("reports a non-zero exit as success when fail_on_error is 'false'", async () => {
    const result = await shellHarness()(context({ command: "exit 3", fail_on_error: "false" }));
    expect(result.status).toBe("success");
    expect(result.exit_code).toBe(3);
  });

  it("runs the command in the configured cwd", async () => {
    const dir = realpathSync(tmpdir());
    const result = await shellHarness(dir)(context({ command: "pwd" }));
    expect(String(result.stdout).trim()).toBe(dir);
  });

  it("fails without running anything when no command is configured", async () => {
    const result = await shellHarness()(context({}));
    expect(result.status).toBe("failed");
  });
});

describe("graph:lint attempt counter (issue #31)", () => {
  function lintHarness(): { lint: NonNullable<ReturnType<typeof createHarnesses>["graph:lint"]>; store: SessionStore } {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-lint-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");
    const deps: HarnessDeps = {
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => "<bpmn:definitions />",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    };
    const lint = createHarnesses(deps)["graph:lint"];
    if (!lint) throw new Error("no 'graph:lint' harness registered");
    return { lint, store };
  }

  it("counts attempts from its own closure rather than trusting context.variables.lint_attempts", async () => {
    const { lint } = lintHarness();

    // Every call reports variables exactly as an unresolved cross-process
    // round-trip would: lint_attempts is never there. The old implementation
    // read that as "no attempts yet" every single time and never reached
    // gw_lint's lint_attempts >= 3 cap (issue #31).
    const call = (): ReturnType<typeof lint> =>
      lint({ activityId: "lint_fragment", harness: "graph:lint", properties: {}, input: {}, variables: {} });

    const attempts = [await call(), await call()].map((r) => r.attempt);
    expect(attempts).toEqual([1, 2]);
  });

  it("gives up (throws) rather than trust gw_lint's own routing once the cap is reached (issue #34)", async () => {
    // gw_lint's `lint_attempts >= 3` gateway condition exists to route the cap
    // to craft_rejected, but a real run found bpmn-elements replay a stale
    // routing decision on a resumed run and redraft forever regardless of what
    // that condition evaluates to. Throwing on the terminal attempt does not
    // depend on that gateway at all.
    const { lint, store } = lintHarness();
    const call = (): ReturnType<typeof lint> =>
      lint({ activityId: "lint_fragment", harness: "graph:lint", properties: {}, input: {}, variables: {} });

    await call();
    await call();
    await expect(call()).rejects.toThrow(/gave up after 3 attempts/);

    // Recorded where the CLI can find it regardless of how bpmn-elements
    // re-wraps the thrown error crossing a callActivity boundary.
    expect(store.readMeta().harnessError).toMatch(/gave up after 3 attempts/);

    // Terminal (the cap was hit) starts the next, unrelated craft invocation
    // fresh rather than staying exhausted forever.
    expect((await call()).attempt).toBe(1);
  });
});

describe("graph:layout strips a wrapping markdown fence (issue #37)", () => {
  function layoutHarness() {
    const deps = {
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store: {} as HarnessDeps["store"],
      getGraph: () => "",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    };
    const layout = createHarnesses(deps)["graph:layout"];
    if (!layout) throw new Error("no 'graph:layout' harness registered");
    return layout;
  }

  it("removes a ```xml fence a model wraps its draft in", async () => {
    const layout = layoutHarness();
    const fenced = '```xml\n<bpmn:definitions id="d"><bpmn:process id="p" /></bpmn:definitions>\n```';
    const bare = await layout({ activityId: "layout_fragment", harness: "graph:layout", properties: {}, input: { fragment: fenced }, variables: {} });
    // auto-layout only succeeds on real, unfenced BPMN XML -- a status of
    // "success" here proves the fence markers did not reach the parser.
    expect(bare.status).toBe("success");
  });

  it("leaves fragment text with no fence alone", async () => {
    const layout = layoutHarness();
    const plain = '<bpmn:definitions id="d"><bpmn:process id="p" /></bpmn:definitions>';
    const result = await layout({ activityId: "layout_fragment", harness: "graph:layout", properties: {}, input: { fragment: plain }, variables: {} });
    expect(result.status).toBe("success");
  });
});

describe("agent:turn consumes agent_role and lint_feedback (issue #37)", () => {
  it("layers the role's instructions and any redraft feedback in front of the graph's own prompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("<bpmn:definitions />")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => "<bpmn:definitions />",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "draft_fragment",
      harness: "agent:turn",
      properties: { agent_role: "graph_architect" },
      input: { prompt: "add a lint step", lint_feedback: "the fragment is not valid BPMN: unexpected end of file" },
      variables: {},
    });

    expect(sentUserText).toContain("no markdown code fences");
    expect(sentUserText).toContain("add a lint step");
    expect(sentUserText).toContain("the fragment is not valid BPMN: unexpected end of file");
  });

  it("gives graph_architect the current graph so an additive splice is possible", async () => {
    // checkSplice rejects a fragment that renames or drops any existing element
    // id; a real Haiku run showed the model has no way to honor that without
    // seeing what already exists, and reused nothing every single attempt.
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-graph-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("<bpmn:definitions />")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => '<bpmn:definitions id="craft_graph"><bpmn:startEvent id="craft_start" /></bpmn:definitions>',
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "draft_fragment",
      harness: "agent:turn",
      properties: { agent_role: "graph_architect" },
      input: { prompt: "add a lint step" },
      variables: {},
    });

    expect(sentUserText).toContain("craft_start");
    expect(sentUserText).toContain("current graph you are splicing into");
  });

  it("does not inject a current-graph block for roles that don't ask for it", async () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-none-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("ok")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => '<bpmn:definitions id="craft_graph"><bpmn:startEvent id="craft_start" /></bpmn:definitions>',
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "some_turn",
      harness: "agent:turn",
      properties: {},
      input: { prompt: "say hi" },
      variables: {},
    });

    expect(sentUserText).not.toContain("craft_start");
    expect(sentUserText).not.toContain("current graph you are splicing into");
  });
});
