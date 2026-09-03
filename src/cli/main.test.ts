// @vitest-environment node
import { describe, expect, it, beforeAll } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEpipeGuard, parseAnswers, answersFor, boundedOnWait, reportWait } from "./main.ts";
import { bundledWorkflowsDir, ensurePaths, paths as resolvePaths } from "../agent/paths.ts";
import { SessionStore } from "../agent/session-store.ts";
import { stampModel } from "../agent/versioning.ts";

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
    const cli = spawn("node", [distFile, "ui", "--port", "0", ...args], {
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
        if (stdout.includes("graph-agent ui")) resolve();
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

  it("warns when --host binds off loopback, since the ui has no authentication", async () => {
    const { stderr } = await runStudio(["--host", "0.0.0.0", "--no-open"]);
    expect(stderr).toContain("0.0.0.0");
    expect(stderr).toMatch(/no authentication/);
  }, 20000);

  it("does not warn for the loopback default", async () => {
    const { stderr } = await runStudio(["--host", "127.0.0.1", "--no-open"]);
    expect(stderr).not.toMatch(/no authentication/);
  }, 20000);

  it("rejects a non-numeric --port instead of crashing with a NaN listen() error (issue #77)", () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-studio-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });
    const result = spawnSync("node", [distFile, "ui", "--port", "abc", "--no-open"], { env, encoding: "utf8" });
    expect(result.stderr).toContain("--port must be an integer");
    expect(result.stderr).toContain("got 'abc'");
    expect(result.status).toBe(1);
  });
});

describe("cmdInit and BPMN model versioning upgrades", () => {
  const distFile = join(import.meta.dirname, "..", "..", "dist", "graph-agent.js");

  it("seeds bundled workflows and config on initial run", () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-init-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    const result = spawnSync("node", [distFile, "init"], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(existsSync(join(home, "config", "graph-agent", "workflows", "session-default.bpmn"))).toBe(true);
    expect(existsSync(join(home, "config", "graph-agent", "config.toml"))).toBe(true);
  });

  it("automatically upgrades unmodified older library graphs to the new bundled version", () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-init-upgrade-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });

    // Simulate an older unmodified version on disk
    const target = join(home, "config", "graph-agent", "workflows", "session-default.bpmn");
    const oldXml = stampModel(readFileSync(target, "utf8").replace('id="session_default"', 'id="session_default"'), "0.0.9");
    writeFileSync(target, oldXml);

    const result = spawnSync("node", [distFile, "init"], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("upgraded 1 unmodified graph(s) to newer bundled version: session-default");
  }, 20000);

  it("detects manual modifications and preserves them with an upgrade prompt", () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-init-modified-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });

    // Simulate user editing the workflow manually
    const target = join(home, "config", "graph-agent", "workflows", "session-default.bpmn");
    const userXml = readFileSync(target, "utf8").replace('name="Run the Pi loop"', 'name="My Custom Loop"');
    writeFileSync(target, userXml);

    const result = spawnSync("node", [distFile, "init"], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 graph(s) differ from the bundled version and contain manual modifications: session-default");
    // Verify user file was NOT overwritten
    expect(readFileSync(target, "utf8")).toContain("My Custom Loop");
  });

  it("backs up manually modified graphs and refreshes them when --refresh is used", () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-init-refresh-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });

    const target = join(home, "config", "graph-agent", "workflows", "session-default.bpmn");
    const userXml = readFileSync(target, "utf8").replace('name="Run the Pi loop"', 'name="My Custom Loop"');
    writeFileSync(target, userXml);

    const result = spawnSync("node", [distFile, "init", "--refresh"], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("refreshed from the bundled version (old copy backed up as .bak): session-default");
    expect(existsSync(`${target}.bak`)).toBe(true);
    expect(readFileSync(`${target}.bak`, "utf8")).toContain("My Custom Loop");
    expect(readFileSync(target, "utf8")).not.toContain("My Custom Loop");
  });

  it("chmods u+w the workflow files after copying them", () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-init-perms-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    const result = spawnSync("node", [distFile, "init"], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    const workflowsDir = join(home, "config", "graph-agent", "workflows");
    const bpmnFiles = readdirSync(workflowsDir).filter((f) => f.endsWith(".bpmn"));
    expect(bpmnFiles.length).toBeGreaterThan(0);
    for (const file of bpmnFiles) {
      const mode = statSync(join(workflowsDir, file)).mode;
      expect(mode & 0o200).toBe(0o200);
    }
  });

  it("chmods u+w the workflow files after copying them even when source is read-only", () => {
    const bundledFile = join(bundledWorkflowsDir(), "session-craft.bpmn");
    const originalMode = statSync(bundledFile).mode;
    chmodSync(bundledFile, 0o444);
    try {
      const home = mkdtempSync(join(tmpdir(), "graph-agent-init-perms-ro-src-"));
      const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
      const result = spawnSync("node", [distFile, "init"], { env, encoding: "utf8" });

      expect(result.status).toBe(0);
      const target = join(home, "config", "graph-agent", "workflows", "session-craft.bpmn");
      expect(existsSync(target)).toBe(true);
      expect(statSync(target).mode & 0o200).toBe(0o200);
    } finally {
      chmodSync(bundledFile, originalMode);
    }
  });

  it("chmods u+w the workflow files after copying them even if existing target was read-only", () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-init-perms-ro-dest-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });

    const target = join(home, "config", "graph-agent", "workflows", "session-default.bpmn");
    // Simulate user editing the workflow manually, and having read-only permissions
    const userXml = readFileSync(target, "utf8").replace('name="Run the Pi loop"', 'name="My Custom Loop"');
    writeFileSync(target, userXml);
    chmodSync(target, 0o444);
    expect(statSync(target).mode & 0o200).toBe(0);

    const refreshResult = spawnSync("node", [distFile, "init", "--refresh"], { env, encoding: "utf8" });
    expect(refreshResult.status).toBe(0);
    expect(statSync(target).mode & 0o200).toBe(0o200);
    expect(statSync(`${target}.bak`).mode & 0o200).toBe(0o200);
  });
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
    function captureStderr(fn: () => void): string {
      const chunks: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        fn();
      } finally {
        process.stderr.write = original;
      }
      return chunks.join("");
    }

    it("an unscoped answer hits the cap, then reports it and leaves the gate parked (advises scoping)", () => {
      const answers = parseAnswers(["x=1"]);
      const onWait = boundedOnWait(answers);
      const output = captureStderr(() => {
        for (let i = 0; i < 5; i++) {
          expect(onWait("gate")).toEqual({ x: 1 });
        }
        expect(onWait("gate")).toBeUndefined();
      });
      expect(output).toMatch(/gate was auto-answered 5 times/);
      // The payload might have leaked in from a gate it was never meant for --
      // scoping it is real, actionable advice here.
      expect(output).toMatch(/scope your answer/);
    });

    it("a scoped answer hits the cap too, but is never told to scope advice it already followed (issue #62)", () => {
      const answers = parseAnswers(["gate:x=1"]);
      const onWait = boundedOnWait(answers);
      const output = captureStderr(() => {
        for (let i = 0; i < 5; i++) {
          expect(onWait("gate")).toEqual({ x: 1 });
        }
        expect(onWait("gate")).toBeUndefined();
      });
      expect(output).toMatch(/gate was auto-answered 5 times/);
      // The user already aimed this at "gate" deliberately -- the graph
      // itself is what is not terminating, not a misdirected payload.
      expect(output).not.toMatch(/scope your answer/);
      expect(output).toMatch(/keeps revisiting/);
    });

    it("counts each activity id on its own budget", () => {
      const answers = parseAnswers(["x=1"]);
      const onWait = boundedOnWait(answers);
      for (let i = 0; i < 5; i++) onWait("a");
      expect(onWait("b")).toEqual({ x: 1 });
    });
  });

  describe("reportWait suggests only real human gates (issue #61)", () => {
    const NS =
      'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

    // A shell service task (never answerable by --answer) and a callActivity
    // (also never answerable) alongside the one real human gate -- the same
    // mix issue #61's own repro saw: `waiting on shell_ls, gw_more,
    // await_intent`, with the naive `tokens[0]` naming the unanswerable one.
    const graph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_wait_test" ${NS}>
  <bpmn:process id="wait_test" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="gate_form">{"components":[{"label":"Reason","type":"textfield","key":"reason","id":"reason"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start" />
    <bpmn:serviceTask id="shell_ls" name="List">
      <bpmn:extensionElements><zeebe:taskDefinition type="shell" /></bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:callActivity id="craft" name="Craft" calledElement="other" />
    <bpmn:userTask id="gate" name="Approve?">
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="gate_form" />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:endEvent id="end" />
  </bpmn:process>
</bpmn:definitions>`;

    function sessionParkedOn(tokens: string[]): { paths: ReturnType<typeof ensurePaths>; sessionId: string } {
      const home = mkdtempSync(join(tmpdir(), "graph-agent-reportwait-"));
      const paths = ensurePaths(
        resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
      );
      const store = new SessionStore(paths, "s1");
      store.create("/tmp/some-project");
      store.appendGraph(graph, "started", []);
      store.update((meta) => {
        meta.tokens = tokens;
      });
      return { paths, sessionId: store.id };
    }

    async function capturedStdout(fn: () => Promise<void>): Promise<string> {
      const chunks: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await fn();
      } finally {
        process.stdout.write = original;
      }
      return chunks.join("");
    }

    it("names the human gate, not the service task or callActivity that happen to come first", async () => {
      const { paths, sessionId } = sessionParkedOn(["shell_ls", "craft", "gate"]);
      const output = await capturedStdout(() => reportWait(paths, sessionId, "stopped"));

      expect(output).toContain("waiting on shell_ls, craft, gate");
      expect(output).toContain(`answer with: graph-agent resume ${sessionId} --answer gate:reason=value`);
      expect(output).not.toContain("--answer shell_ls");
      expect(output).not.toContain("--answer craft");
    });

    it("suggests no --answer at all when nothing waiting is a human gate", async () => {
      const { paths, sessionId } = sessionParkedOn(["shell_ls", "craft"]);
      const output = await capturedStdout(() => reportWait(paths, sessionId, "stopped"));

      expect(output).toContain("waiting on shell_ls, craft");
      expect(output).not.toContain("--answer");
      expect(output).toContain(`graph-agent resume ${sessionId}`);
    });

    it("says nothing at all for an outcome other than 'stopped'", async () => {
      const { paths, sessionId } = sessionParkedOn(["gate"]);
      const output = await capturedStdout(() => reportWait(paths, sessionId, "completed"));
      expect(output).toBe("");
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
    }, 20000);

    it("caps how many times an unscoped answer auto-answers the same looping gate", () => {
      const { env } = project();
      const { stdout, stderr, code } = runCli(env, ["run", "--graph", "loop_gate", "--dry-run", "--answer", "key=hello"]);
      // Bounded and reported, not an infinite loop burning turns forever.
      expect(stderr).toMatch(/gate was auto-answered 5 times/);
      expect(stderr).toMatch(/scope your answer/);
      expect(stdout).toContain("stopped");
      expect(stdout).toContain("waiting on gate");
      expect(code).toBe(0);
    });

    it("caps a scoped answer too, without the (already-followed) advice to scope it (issue #62)", () => {
      const { env } = project();
      const { stdout, stderr, code } = runCli(env, [
        "run",
        "--graph",
        "loop_gate",
        "--dry-run",
        "--answer",
        "gate:key=hello",
      ]);
      expect(stderr).toMatch(/gate was auto-answered 5 times/);
      expect(stderr).not.toMatch(/scope your answer/);
      expect(stderr).toMatch(/keeps revisiting/);
      expect(stdout).toContain("stopped");
      expect(code).toBe(0);
    });

    it("--max-auto-answers lowers the cap, and the message names the flag to raise it (issue #71)", () => {
      const { env } = project();
      const { stdout, stderr, code } = runCli(env, [
        "run",
        "--graph",
        "loop_gate",
        "--dry-run",
        "--answer",
        "key=hello",
        "--max-auto-answers",
        "2",
      ]);
      expect(stderr).toMatch(/gate was auto-answered 2 times/);
      expect(stderr).toMatch(/the cap is 2 per activity/);
      expect(stderr).toMatch(/--max-auto-answers/);
      expect(stdout).toContain("stopped");
      expect(code).toBe(0);
    });

    it("rejects a non-positive-integer --max-auto-answers instead of silently ignoring it", () => {
      const { env } = project();
      const { stderr, code } = runCli(env, [
        "run",
        "--graph",
        "loop_gate",
        "--dry-run",
        "--answer",
        "key=hello",
        "--max-auto-answers",
        "0",
      ]);
      expect(stderr).toMatch(/--max-auto-answers must be a positive integer/);
      expect(code).toBe(1);
    });

    it("echoes the raw value, not a coerced NaN, for a non-numeric --max-auto-answers (issue #77)", () => {
      const { env } = project();
      const { stderr, code } = runCli(env, [
        "run",
        "--graph",
        "loop_gate",
        "--dry-run",
        "--answer",
        "key=hello",
        "--max-auto-answers",
        "abc",
      ]);
      expect(stderr).toMatch(/--max-auto-answers must be a positive integer, got 'abc'/);
      expect(stderr).not.toMatch(/NaN/);
      expect(code).toBe(1);
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

describe("graph-agent promote (issue #55)", () => {
  const distFile = join(import.meta.dirname, "..", "..", "dist", "graph-agent.js");
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
    'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI"';

  // bpmnlint's no-bpmndi rule (which `graph-agent promote` runs) requires a
  // shape/edge for every element -- minimal but complete DI, not omitted like
  // link.test.ts's fixtures (which never go through a lint gate).
  const callee = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_promote_callee" ${NS}>
  <bpmn:process id="promote_callee" isExecutable="true">
    <bpmn:startEvent id="ce_start" name="Start"><bpmn:outgoing>cef1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="cef1" sourceRef="ce_start" targetRef="ce_task" />
    <bpmn:serviceTask id="ce_task" name="Check">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="shell" />
        <zeebe:taskHeaders><zeebe:header key="command" value="true" /></zeebe:taskHeaders>
      </bpmn:extensionElements>
      <bpmn:incoming>cef1</bpmn:incoming><bpmn:outgoing>cef2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="cef2" sourceRef="ce_task" targetRef="ce_end" />
    <bpmn:endEvent id="ce_end" name="End"><bpmn:incoming>cef2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_promote_callee">
    <bpmndi:BPMNPlane id="Plane_promote_callee" bpmnElement="promote_callee">
      <bpmndi:BPMNShape id="ce_start_di" bpmnElement="ce_start"><dc:Bounds x="0" y="0" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="ce_task_di" bpmnElement="ce_task"><dc:Bounds x="100" y="-22" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="ce_end_di" bpmnElement="ce_end"><dc:Bounds x="260" y="0" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="cef1_di" bpmnElement="cef1"><di:waypoint x="36" y="18" /><di:waypoint x="100" y="18" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="cef2_di" bpmnElement="cef2"><di:waypoint x="200" y="18" /><di:waypoint x="260" y="18" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  const caller = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_promote_caller" ${NS}>
  <bpmn:process id="promote_caller" isExecutable="true">
    <bpmn:startEvent id="ca_start" name="Start"><bpmn:outgoing>caf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="caf1" sourceRef="ca_start" targetRef="call" />
    <bpmn:callActivity id="call" name="Call callee" calledElement="promote_callee">
      <bpmn:incoming>caf1</bpmn:incoming><bpmn:outgoing>caf2</bpmn:outgoing>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="caf2" sourceRef="call" targetRef="ca_end" />
    <bpmn:endEvent id="ca_end" name="End"><bpmn:incoming>caf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_promote_caller">
    <bpmndi:BPMNPlane id="Plane_promote_caller" bpmnElement="promote_caller">
      <bpmndi:BPMNShape id="ca_start_di" bpmnElement="ca_start"><dc:Bounds x="0" y="0" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="call_di" bpmnElement="call"><dc:Bounds x="100" y="-22" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="ca_end_di" bpmnElement="ca_end"><dc:Bounds x="260" y="0" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="caf1_di" bpmnElement="caf1"><di:waypoint x="36" y="18" /><di:waypoint x="100" y="18" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="caf2_di" bpmnElement="caf2"><di:waypoint x="200" y="18" /><di:waypoint x="260" y="18" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

  function project(): { env: NodeJS.ProcessEnv; workflowsDir: string } {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-promote-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });
    const workflowsDir = join(home, "config", "graph-agent", "workflows");
    writeFileSync(join(workflowsDir, "promote_caller.bpmn"), caller);
    writeFileSync(join(workflowsDir, "promote_callee.bpmn"), callee);
    return { env, workflowsDir };
  }

  function runCli(env: NodeJS.ProcessEnv, args: string[]): { stdout: string; stderr: string; code: number | null } {
    const result = spawnSync("node", [distFile, ...args], { env, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: result.status };
  }

  function sessionIdOf(stdout: string): string {
    const id = /^session (\S+)/m.exec(stdout)?.[1];
    if (!id) throw new Error(`no session id in:\n${stdout}`);
    return id;
  }

  it("promotes a session's graph, unlinked, under a fresh definitions id", () => {
    const { env, workflowsDir } = project();
    const first = runCli(env, ["run", "--graph", "promote_caller", "--dry-run"]);
    const sessionId = sessionIdOf(first.stdout);

    const promoted = runCli(env, ["promote", sessionId, "--as", "promoted_caller"]);
    expect(promoted.code).toBe(0);

    const target = join(workflowsDir, "promoted_caller.bpmn");
    expect(existsSync(target)).toBe(true);
    const xml = readFileSync(target, "utf8");
    expect((xml.match(/<bpmn:process /g) ?? []).length).toBe(1);
    expect(xml).toContain('calledElement="promote_callee"');
    expect(xml).not.toContain("Defs_promote_caller\"");
    expect(xml).toContain('id="Defs_promoted_caller"');
    // Issue #64: the process id itself is rewritten too, not just the
    // definitions id -- otherwise this and the source graph both define a
    // process called "promote_caller", and calledElement (which names a
    // process, not a file) resolves to whichever the library indexes last.
    expect(xml).toContain('<bpmn:process id="promoted_caller"');
    expect(promoted.stdout).toContain('calledElement="promoted_caller"');

    // Runs as a fresh session, re-linking promote_callee on its own.
    const rerun = runCli(env, ["run", "--graph", "promoted_caller", "--dry-run"]);
    expect(rerun.stdout).toContain("completed");
  }, 20000);

  it("promotes the same session twice under two names without a process id collision (issue #64)", () => {
    const { env, workflowsDir } = project();
    const first = runCli(env, ["run", "--graph", "promote_caller", "--dry-run"]);
    const sessionId = sessionIdOf(first.stdout);

    const p1 = runCli(env, ["promote", sessionId, "--as", "converged"]);
    expect(p1.code).toBe(0);
    const p2 = runCli(env, ["promote", sessionId, "--as", "converged2"]);
    expect(p2.code).toBe(0);

    const xml1 = readFileSync(join(workflowsDir, "converged.bpmn"), "utf8");
    const xml2 = readFileSync(join(workflowsDir, "converged2.bpmn"), "utf8");
    expect(xml1).toContain('<bpmn:process id="converged"');
    expect(xml2).toContain('<bpmn:process id="converged2"');

    // A third graph calling "converged2" by process id reaches that one
    // specifically -- not whichever the library happens to index last.
    const thirdGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_third" ${NS}>
  <bpmn:process id="third" isExecutable="true">
    <bpmn:startEvent id="t_start"><bpmn:outgoing>tf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="tf1" sourceRef="t_start" targetRef="call2" />
    <bpmn:callActivity id="call2" calledElement="converged2">
      <bpmn:incoming>tf1</bpmn:incoming><bpmn:outgoing>tf2</bpmn:outgoing>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="tf2" sourceRef="call2" targetRef="t_end" />
    <bpmn:endEvent id="t_end"><bpmn:incoming>tf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    writeFileSync(join(workflowsDir, "third.bpmn"), thirdGraph);
    const rerun = runCli(env, ["run", "--graph", "third", "--dry-run"]);
    expect(rerun.stdout).toContain("completed");
  }, 20000);

  it("refuses a process id already used by a different library file, without --force (issue #64)", () => {
    const { env } = project();
    const first = runCli(env, ["run", "--graph", "promote_caller", "--dry-run"]);
    const sessionId = sessionIdOf(first.stdout);

    // "promote-callee" is a different *file* from the existing
    // "promote_callee.bpmn" (so the file-existence check does not fire
    // first), but --as normalises '-' to '_' the same way `graph-agent
    // promote`'s own process id does -- both name the same process.
    const collision = runCli(env, ["promote", sessionId, "--as", "promote-callee"]);
    expect(collision.code).not.toBe(0);
    expect(collision.stderr).toMatch(/process id 'promote_callee' is already used/);

    const withForce = runCli(env, ["promote", sessionId, "--as", "promote-callee", "--force"]);
    expect(withForce.code).toBe(0);
  }, 20000);

  it("requires --as", () => {
    const { env } = project();
    const first = runCli(env, ["run", "--graph", "promote_caller", "--dry-run"]);
    const sessionId = sessionIdOf(first.stdout);
    const result = runCli(env, ["promote", sessionId]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--as/);
  }, 20000);

  it("refuses an unknown session", () => {
    const { env } = project();
    const result = runCli(env, ["promote", "nonexistent", "--as", "x"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown session");
  }, 20000);

  it("refuses to overwrite an existing library graph without --force, and backs it up with --force", () => {
    const { env, workflowsDir } = project();
    const first = runCli(env, ["run", "--graph", "promote_caller", "--dry-run"]);
    const sessionId = sessionIdOf(first.stdout);
    runCli(env, ["promote", sessionId, "--as", "promoted_caller"]);

    const withoutForce = runCli(env, ["promote", sessionId, "--as", "promoted_caller"]);
    expect(withoutForce.code).not.toBe(0);
    expect(withoutForce.stderr).toMatch(/--force/);

    const withForce = runCli(env, ["promote", sessionId, "--as", "promoted_caller", "--force"]);
    expect(withForce.code).toBe(0);
    expect(existsSync(join(workflowsDir, "promoted_caller.bpmn.bak"))).toBe(true);
  }, 20000);
});

describe("graph-agent model and headless flags", () => {
  const distFile = join(import.meta.dirname, "..", "..", "dist", "graph-agent.js");

  function project(): { env: NodeJS.ProcessEnv; configFile: string } {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-cli-model-"));
    const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
    execFileSync("node", [distFile, "init"], { env });
    const configFile = join(home, "config", "graph-agent", "config.toml");
    return { env, configFile };
  }

  function runCli(env: NodeJS.ProcessEnv, args: string[]): { stdout: string; stderr: string; code: number | null } {
    const result = spawnSync("node", [distFile, ...args], { env, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: result.status };
  }

  it("lists configured model with `graph-agent model`", () => {
    const { env } = project();
    const result = runCli(env, ["model"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("configured default:");
  });

  it("sets default model with `graph-agent model <provider/model>`", () => {
    const { env, configFile } = project();
    const setRes = runCli(env, ["model", "anthropic/claude-sonnet-4-5"]);
    expect(setRes.code).toBe(0);
    expect(setRes.stdout).toContain("set default model");
    expect(setRes.stdout).toContain("anthropic/claude-sonnet-4-5");

    const checkRes = runCli(env, ["model"]);
    expect(checkRes.code).toBe(0);
    expect(checkRes.stdout).toContain("configured default: anthropic/claude-sonnet-4-5");

    const content = readFileSync(configFile, "utf8");
    expect(content).toContain('model = "anthropic/claude-sonnet-4-5"');
  });

  it("supports running headlessly with --no-tui", () => {
    const { env } = project();
    const result = runCli(env, ["--no-tui", "--graph", "session-default", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("session");
  }, 20000);

  it("removes a session with `graph-agent rm <id>`", () => {
    const { env } = project();
    // Run a dry session first to create one
    const runRes = runCli(env, ["run", "--dry-run", "test prompt"]);
    expect(runRes.code).toBe(0);

    const lsRes = runCli(env, ["ls"]);
    expect(lsRes.code).toBe(0);
    const sessionId = lsRes.stdout.trim().split(/\s+/)[0];
    expect(sessionId).toBeDefined();

    const rmRes = runCli(env, ["rm", sessionId!]);
    expect(rmRes.code).toBe(0);
    expect(rmRes.stdout).toContain(`removed session ${sessionId}`);

    const afterLs = runCli(env, ["ls"]);
    expect(afterLs.stdout).toContain("no sessions in this project yet");
  }, 20000);
});

