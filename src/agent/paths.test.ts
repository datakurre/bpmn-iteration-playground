// @vitest-environment node
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { paths, projectId, projectName, xdgConfigHome, xdgStateHome } from "./paths.ts";

describe("XDG resolution", () => {
  it("honours XDG_CONFIG_HOME and XDG_STATE_HOME", () => {
    const env = { XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv;
    expect(xdgConfigHome(env)).toBe("/cfg");
    expect(xdgStateHome(env)).toBe("/state");
    const p = paths(env);
    expect(p.workflowsDir).toBe(join("/cfg", "graph-agent", "workflows"));
    expect(p.sessionsDir).toBe(join("/state", "graph-agent", "sessions"));
  });

  it("falls back to the XDG defaults when unset or blank", () => {
    for (const env of [{}, { XDG_CONFIG_HOME: "  ", XDG_STATE_HOME: "" }] as NodeJS.ProcessEnv[]) {
      expect(xdgConfigHome(env)).toMatch(/\.config$/);
      expect(xdgStateHome(env)).toMatch(/\.local\/state$/);
    }
  });

  it("keeps the shared graph library out of the state directory", () => {
    // Graphs are shared between projects and worth keeping; sessions are not.
    const p = paths({ XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv);
    expect(p.workflowsDir.startsWith(p.configDir)).toBe(true);
    expect(p.sessionsDir.startsWith(p.stateDir)).toBe(true);
    expect(p.workflowsDir.startsWith(p.stateDir)).toBe(false);
  });
});

describe("projectId", () => {
  it("is absolute and stable for the same directory", () => {
    expect(projectId(".")).toBe(projectId(process.cwd()));
    expect(projectId(".").startsWith("/")).toBe(true);
  });

  it("names a project by its last path segment", () => {
    expect(projectName("/home/me/src/my-project")).toBe("my-project");
    expect(projectName("/home/me/src/my-project/")).toBe("my-project");
  });
});
