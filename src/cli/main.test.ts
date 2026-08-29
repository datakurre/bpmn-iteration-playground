// @vitest-environment node
import { describe, expect, it, beforeAll } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEpipeGuard } from "./main.ts";
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
