// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeVisited, SessionStore } from "./session-store.ts";
import { ensurePaths, paths as resolvePaths, type Paths } from "./paths.ts";

describe("mergeVisited", () => {
  it("unions rather than replaces, deduped", () => {
    expect(mergeVisited(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("handles an empty starting set", () => {
    expect(mergeVisited([], ["a"])).toEqual(["a"]);
  });
});

describe("SessionStore.markVisited (issue #59)", () => {
  let paths: Paths;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-store-"));
    paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
  });

  it("merges across calls instead of replacing meta.visited wholesale", () => {
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/project");
    store.markVisited(["a", "b"]);
    store.markVisited(["c"]);
    expect(store.readMeta().visited.sort()).toEqual(["a", "b", "c"]);
  });
});
