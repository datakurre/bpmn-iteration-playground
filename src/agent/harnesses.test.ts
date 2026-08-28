// @vitest-environment node
import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHarnesses, type HarnessDeps } from "./harnesses.ts";
import type { HarnessContext } from "./harness.ts";

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
