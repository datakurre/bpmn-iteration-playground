// @vitest-environment node
import { describe, expect, it, beforeAll } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEpipeGuard, parseAnswers, answersFor, boundedOnWait } from "./main.ts";
import { ensurePaths, paths as resolvePaths } from "../agent/paths.ts";
import { SessionStore } from "../agent/session-store.ts";

describe("installEpipeGuard", () => {
  it("swallows an EPIPE error instead of letting it become an unhandled exception", () => {
    const stream = new EventEmitter() as unknown as NodeJS.WritableStream;
    installEpipeGuard([stream]);
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    // If nothing were listening, EventEmitter would itself throw this same
    // error synchronously (Node's default behavior for an unhandled 'error'
    // event) -- so a listener that swallows EPIPE is what keeps this from
    // throwing here.
    expect(() => (stream as unknown as EventEmitter).emit("error", epipe)).not.toThrow();
  });

  it("still surfaces a write error that is not EPIPE", () => {
    const stream = new EventEmitter() as unknown as NodeJS.WritableStream;
    installEpipeGuard([stream]);
    const other = Object.assign(new Error("write EACCES"), { code: "EACCES" });
    expect(() => (stream as unknown as EventEmitter).emit("error", other)).toThrow("write EACCES");
  });
});

describe("piping CLI output to a short consumer (issue #41)", () => {
  const distFile = join(import.meta.dirname, "..", "..", "dist", "graph-agent.js");

  beforeAll(() => {
    // The race this reproduces needs the *built* entry point -- installEpipeGuard
    // only guards process.stdout when main.ts runs as the actual CLI process,
    // which is exactly what dist/graph-agent.js is for. Build it fresh rather
    // than trusting a stale copy left on disk.
    execFileSync("node", [join(import.meta.dirname, "..", "..", "scripts", "build-cli.mjs")], {
      cwd: join(import.meta.dirname, "..", ".."),
    });
    if (!existsSync(distFile)) throw new Error(`build did not produce ${distFile}`);
  });

  it("does not crash with an unhandled EPIPE stack dump when the reader closes early", async () => {
    // `cmdLs` writes one line per session with a bare process.stdout.write in a
    // loop with no backpressure handling -- exactly the shape issue #41
    // describes. A handful of sessions is not enough to reliably overrun a
    // pipe buffer before the reader closes it, so this seeds enough that the
    // first write already exceeds a pipe's capacity, making the race
    // deterministic instead of the 1-in-20 chance the issue reports.
    const home = mkdtempSync(join(tmpdir(), "graph-agent-epipe-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    for (let i = 0; i < 4000; i++) {
      new SessionStore(paths, `s${i}`).create("/tmp/some-project");
    }

    const cli = spawn("node", [distFile, "ls", "--all"], {
      env: { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    cli.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Read a little, then close the read side -- the same shape as piping into
    // `head`, without depending on `head` actually being on PATH.
    cli.stdout.once("data", () => cli.stdout.destroy());

    await new Promise<void>((resolve) => cli.on("close", () => resolve()));

    expect(stderr).not.toContain("Unhandled 'error' event");
    expect(stderr).not.toContain("EPIPE");
  }, 20000);
});

describe("cmdStudio flags (issue #56)", () => {
  const distFile = join(import.meta.dirname, "..", "..", "dist", "graph-agent.js");

  async function runStudio(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-studio-"));
    execFileSync("node", [distFile, "init"], {
      env: { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") },
    });
    const cli = spawn("node", [distFile, "studio", "--port", "0", ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    cli.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    cli.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // The bundle pulls in bpmn-engine/ws/etc, so cold start to first output can
    // take over a second -- wait for the banner rather than a fixed delay, then
    // give the (synchronous, immediately-following) host warning and best-effort
    // browser-opener spawn a moment to run before shutting down.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (stdout.includes("graph-agent studio")) resolve();
      };
      cli.stdout.on("data", check);
      check();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    cli.kill("SIGINT");
    await new Promise<void>((resolve) => cli.on("close", () => resolve()));
    return { stdout, stderr };
  }

  it("does not crash when the default --open cannot find a browser opener", async () => {
    // No PATH assumption made about xdg-open/open/start being installed --
    // the point is that a missing opener is best-effort, never fatal.
    const { stderr } = await runStudio([]);
    expect(stderr).not.toContain("Unhandled 'error' event");
    expect(stderr).not.toContain("ENOENT");
  }, 20000);

  it("--no-open is honoured (parseArgs has no built-in negation)", async () => {
    const { stderr } = await runStudio(["--no-open"]);
    expect(stderr).not.toContain("Unhandled 'error' event");
  }, 20000);

  it("warns when --host binds off loopback, since the studio has no authentication", async () => {
    const { stderr } = await runStudio(["--host", "0.0.0.0", "--no-open"]);
    expect(stderr).toContain("0.0.0.0");
    expect(stderr).toMatch(/no authentication/);
  }, 20000);

  it("does not warn for the loopback default", async () => {
    const { stderr } = await runStudio(["--host", "127.0.0.1", "--no-open"]);
    expect(stderr).not.toMatch(/no authentication/);
  }, 20000);
});

describe("--answer scoping (issue #44)", () => {
  describe("parseAnswers / answersFor", () => {
    it("puts a bare key=value in the unscoped bucket, which answers every activity", () => {
      const answers = parseAnswers(["intent=hello"]);
      expect(answersFor(answers, "await_intent")).toEqual({ intent: "hello" });
      expect(answersFor(answers, "review_fragment")).toEqual({ intent: "hello" });
    });

    it("scopes activity:key=value to that activity only", () => {
      const answers = parseAnswers(["await_intent:intent=hello"]);
      expect(answersFor(answers, "await_intent")).toEqual({ intent: "hello" });
      expect(answersFor(answers, "review_fragment")).toBeUndefined();
    });

    it("merges the unscoped bucket under a scoped one for the same activity", () => {
      const answers = parseAnswers(["done=true", "await_intent:intent=hello"]);
      expect(answersFor(answers, "await_intent")).toEqual({ done: true, intent: "hello" });
      expect(answersFor(answers, "review_fragment")).toEqual({ done: true });
    });

    it("a scoped value overrides an unscoped one for the same key at that activity", () => {
      const answers = parseAnswers(["approval=reject", "review_fragment:approval=apply"]);
      expect(answersFor(answers, "review_fragment")).toEqual({ approval: "apply" });
      expect(answersFor(answers, "other_gate")).toEqual({ approval: "reject" });
    });

    it("a colon after the first '=' is part of the value, not a scope separator", () => {
      const answers = parseAnswers(["command=echo a:b"]);
      expect(answersFor(answers, "anything")).toEqual({ command: "echo a:b" });
    });

    it("coerces true/false/number values, per activity", () => {
      const answers = parseAnswers(["gate:flag=true", "gate:count=3", "gate:label=x"]);
      expect(answersFor(answers, "gate")).toEqual({ flag: true, count: 3, label: "x" });
    });

    it("rejects a pair with no '='", () => {
      expect(() => parseAnswers(["nokeyvalue"])).toThrow(/is not/);
    });

    it("returns undefined for an activity with neither a scoped nor unscoped answer", () => {
      const answers = parseAnswers(["a:x=1"]);
      expect(answersFor(answers, "b")).toBeUndefined();
    });
  });

  describe("boundedOnWait", () => {
    it("answers the same activity up to the cap, then reports it and leaves the gate parked", () => {
      const answers = parseAnswers(["x=1"]);
      const onWait = boundedOnWait(answers);
      const chunks: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        for (let i = 0; i < 5; i++) {
          expect(onWait("gate")).toEqual({ x: 1 });
        }
        expect(onWait("gate")).toBeUndefined();
      } finally {
        process.stderr.write = original;
      }
      expect(chunks.join("")).toMatch(/gate was auto-answered 5 times/);
    });

    it("counts each activity id on its own budget", () => {
      const answers = parseAnswers(["x=1"]);
      const onWait = boundedOnWait(answers);
      for (let i = 0; i < 5; i++) onWait("a");
      expect(onWait("b")).toEqual({ x: 1 });
    });
  });

  describe("run/resume across two gates (CLI, session-skeleton's own shape)", () => {
    const distFile = join(import.meta.dirname, "..", "..", "dist", "graph-agent.js");
    const NS =
      'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
    const FORM =
      '<zeebe:userTaskForm id="gate_form">{"components":[{"label":"Key","type":"textfield","key":"key","id":"key"}]}</zeebe:userTaskForm>';

    // Two human gates in sequence, each publishing the same form field under a
    // different process variable -- close to session-skeleton's own
    // await_intent/review_fragment shape, but self-contained. Both gates read
    // a form field literally named "key" so an *unscoped* `--answer key=...`
    // can satisfy either one, which is exactly the cross-contamination #44
    // reports: a payload meant for one gate silently answering another.
    const twoGates = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_two_gates" ${NS}>
  <bpmn:process id="two_gates" isExecutable="true">
    <bpmn:extensionElements>${FORM}</bpmn:extensionElements>
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate_a" />
    <bpmn:userTask id="gate_a" name="Gate A">
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="gate_form" />
        <zeebe:ioMapping><zeebe:output source="=key" target="a_value" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="f2" sourceRef="gate_a" targetRef="gate_b" />
    <bpmn:userTask id="gate_b" name="Gate B">
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="gate_form" />
        <zeebe:ioMapping><zeebe:output source="=key" target="b_value" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="f3" sourceRef="gate_b" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

    // A single gate whose only outgoing flow loops back onto itself
    // unconditionally -- nothing in the graph itself ever stops asking. Used
    // to prove the auto-answer cap actually bounds a run that an unscoped
    // `--answer` would otherwise keep re-satisfying forever.
    const loopGate = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_loop_gate" ${NS}>
  <bpmn:process id="loop_gate" isExecutable="true">
    <bpmn:extensionElements>${FORM}</bpmn:extensionElements>
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate" name="Loop gate">
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="gate_form" />
        <zeebe:ioMapping><zeebe:output source="=key" target="value" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:incoming>loop</bpmn:incoming>
      <bpmn:outgoing>loop</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="loop" sourceRef="gate" targetRef="gate" />
  </bpmn:process>
</bpmn:definitions>`;

    function project(): { env: NodeJS.ProcessEnv; workflowsDir: string } {
      const home = mkdtempSync(join(tmpdir(), "graph-agent-answer-"));
      const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
      execFileSync("node", [distFile, "init"], { env });
      const workflowsDir = join(home, "config", "graph-agent", "workflows");
      writeFileSync(join(workflowsDir, "two_gates.bpmn"), twoGates);
      writeFileSync(join(workflowsDir, "loop_gate.bpmn"), loopGate);
      return { env, workflowsDir };
    }

    function runCli(env: NodeJS.ProcessEnv, args: string[]): { stdout: string; stderr: string; code: number | null } {
      const result = spawnSync("node", [distFile, ...args], { env, encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr, code: result.status };
    }

    it("a scoped answer for gate_a does not also answer gate_b", () => {
      const { env } = project();
      const { stdout } = runCli(env, ["run", "--graph", "two_gates", "--dry-run", "--answer", "gate_a:key=hello"]);
      expect(stdout).toContain("stopped");
      // Not `toBe` -- `postponedIds(engine)`'s snapshot can still list the just
      // -answered gate_a for one more tick after it ends (a bpmn-elements
      // getPostponed() staleness independent of answer scoping; the "does the
      // wrong gate get auto-answered" question the resume test below settles
      // functionally). The behaviour this test exists to pin is that gate_b is
      // still parked rather than having been silently answered too.
      expect(stdout).toContain("waiting on");
      expect(stdout).toContain("gate_b");
      expect(stdout).not.toContain("completed");
    });

    it("an unscoped answer satisfies both gates in one run (documented, opt-in behaviour)", () => {
      const { env } = project();
      const { stdout } = runCli(env, ["run", "--graph", "two_gates", "--dry-run", "--answer", "key=hello"]);
      expect(stdout).toContain("completed");
      expect(stdout).not.toContain("waiting on");
    });

    it("resuming with a scoped answer for gate_b completes the session", () => {
      const { env } = project();
      const first = runCli(env, ["run", "--graph", "two_gates", "--dry-run", "--answer", "gate_a:key=hello"]);
      const sessionId = /^session (\S+)/m.exec(first.stdout)?.[1];
      expect(sessionId).toBeDefined();
      const second = runCli(env, ["resume", sessionId!, "--dry-run", "--answer", "gate_b:key=world"]);
      expect(second.stdout).toContain("completed");
    });

    it("caps how many times an unscoped answer auto-answers the same looping gate", () => {
      const { env } = project();
      const { stdout, stderr, code } = runCli(env, ["run", "--graph", "loop_gate", "--dry-run", "--answer", "key=hello"]);
      // Bounded and reported, not an infinite loop burning turns forever.
      expect(stderr).toMatch(/gate was auto-answered 5 times/);
      expect(stdout).toContain("stopped");
      expect(stdout).toContain("waiting on gate");
      expect(code).toBe(0);
    });
  });
});

describe("session-default is the out-of-the-box graph (issue #47)", () => {
  const distFile = join(import.meta.dirname, "..", "..", "dist", "graph-agent.js");

  function project(): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-default-graph-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });
    return env;
  }

  it("defaults `run` to session-default, a callActivity into pi-default-loop", () => {
    const env = project();
    const result = spawnSync("node", [distFile, "run", "say hello", "--dry-run"], { env, encoding: "utf8" });
    expect(result.stdout).toContain("graph  session-default");
    // Same observable transcript as running pi-default-loop directly --
    // the callActivity is transparent to the harness-level progress log.
    expect(result.stdout).toContain("inject_pending  agent:steer");
    expect(result.stdout).toContain("llm_turn  agent:turn");
    expect(result.stdout).toContain("drain_followup  agent:follow-up");
    expect(result.stdout).toContain("completed");
  });

  it("refuses a positional prompt on a graph whose first stop is a human gate, rather than dropping it", () => {
    const env = project();
    const result = spawnSync(
      "node",
      [distFile, "run", "--graph", "session-skeleton", "Add a step that runs 'ls -la'", "--dry-run"],
      { env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("await_intent");
    expect(result.stderr).toMatch(/never see/);
  });

  it("still runs session-skeleton fine with no positional prompt", () => {
    const env = project();
    const result = spawnSync("node", [distFile, "run", "--graph", "session-skeleton", "--dry-run"], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("waiting on await_intent");
  });
});
