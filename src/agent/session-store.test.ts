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
