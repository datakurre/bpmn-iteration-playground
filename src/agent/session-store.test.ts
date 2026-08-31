// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphRevisionConflictError, mergeVisited, SessionStore } from "./session-store.ts";
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

describe("SessionStore.appendGraph's optimistic concurrency (issue #75)", () => {
  let paths: Paths;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-store-"));
    paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
  });

  it("accepts a write whose expectedIndex matches the revision count on disk", () => {
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/project");
    store.appendGraph("<a/>", "first", [], 0);
    expect(store.readMeta().revisions).toHaveLength(1);
    expect(store.currentGraph()).toBe("<a/>");
  });

  it("rejects a write whose expectedIndex has fallen behind, naming the revision actually on disk", () => {
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/project");
    store.appendGraph("<a/>", "first", []); // index 0, unchecked
    // A second writer (e.g. a studio PUT) still believes it is extending
    // revision 0, but a revision has already landed there.
    let caught: unknown;
    try {
      store.appendGraph("<b/>", "second", [], 0);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphRevisionConflictError);
    expect((caught as GraphRevisionConflictError).currentIndex).toBe(1);
    // The rejected write never landed: still just the one revision.
    expect(store.readMeta().revisions).toHaveLength(1);
    expect(store.currentGraph()).toBe("<a/>");
  });

  it("skips the check entirely when no expectedIndex is given", () => {
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/project");
    store.appendGraph("<a/>", "first", []);
    expect(() => store.appendGraph("<b/>", "second", [])).not.toThrow();
    expect(store.readMeta().revisions).toHaveLength(2);
  });
});

describe("computeSessionStats", () => {
  it("calculates cumulative tokens, costs, and cache hit ratio across turns", async () => {
    const { computeSessionStats } = await import("./session-store.ts");
    const turns = [
      {
        index: 1,
        activityId: "turn_1",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 100,
          cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
        },
      },
      {
        index: 2,
        activityId: "turn_2",
        usage: {
          input: 20,
          output: 80,
          cacheRead: 80,
          cacheWrite: 20,
          totalTokens: 180,
          cost: { input: 0.0002, output: 0.0016, cacheRead: 0.0001, cacheWrite: 0, total: 0.0019 },
        },
      },
    ];

    const stats = computeSessionStats(turns);
    expect(stats.totalCostUSD).toBeCloseTo(0.0039);
    expect(stats.totalInputTokens).toBe(120);
    expect(stats.totalOutputTokens).toBe(130);
    expect(stats.totalCacheReadTokens).toBe(80);
    expect(stats.totalCacheWriteTokens).toBe(120);
    // cache hit ratio = 80 / (120 + 80) = 80 / 200 = 0.40
    expect(stats.cacheHitRatio).toBe(0.4);
  });
});

describe("SessionStore.delete", () => {
  let paths: Paths;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-store-"));
    paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
  });

  it("deletes the session directory from disk", () => {
    const store = new SessionStore(paths, "s-to-delete");
    store.create("/tmp/project");
    expect(store.exists()).toBe(true);
    store.delete();
    expect(store.exists()).toBe(false);
  });

  it("is a no-op on a non-existent session", () => {
    const store = new SessionStore(paths, "s-nonexistent");
    expect(store.exists()).toBe(false);
    expect(() => store.delete()).not.toThrow();
  });
});
