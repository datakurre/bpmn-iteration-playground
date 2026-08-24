import { describe, it, expect } from "vitest";
import { buildPurgeAllRequest, buildPurgeRequest, describePurge, describePurgeAll, selectPurgedIds } from "./savepoint-purge";
import type { SavePointSummary } from "./savepoint-purge";

const points: SavePointSummary[] = [
  { id: "sp1", task_id: "t1", task_name: "Extract Clauses", created_at: "2026-08-21T00:00:00Z" },
  { id: "sp2", task_id: "t1", task_name: "Extract Clauses", created_at: "2026-08-21T00:01:00Z" },
  { id: "sp3", task_id: "t7", task_name: "Review Contract", created_at: "2026-08-21T00:02:00Z" },
  { id: "sp4", task_id: "t9", task_name: "Finalize", created_at: "2026-08-21T00:03:00Z" },
];
const oldestId = "sp1";

describe("buildPurgeRequest", () => {
  it("anchors on the task id of the chosen savepoint", () => {
    expect(buildPurgeRequest({ id: "sp3", task_id: "t7" } as SavePointSummary)).toEqual({ before_task_id: "t7" });
  });

  it("refuses a savepoint with no task id", () => {
    expect(() => buildPurgeRequest({ id: "sp3" } as SavePointSummary)).toThrow();
  });
});

describe("selectPurgedIds", () => {
  it("never counts the anchor savepoint as purged", () => {
    expect(selectPurgedIds(points, "sp3")).not.toContain("sp3");
  });

  it("selects every savepoint strictly older than the anchor", () => {
    expect(selectPurgedIds(points, "sp3")).toEqual(["sp1", "sp2"]);
  });

  it("selects nothing for the oldest savepoint", () => {
    expect(selectPurgedIds(points, oldestId)).toEqual([]);
  });
});

describe("describePurge", () => {
  it("counts what will be removed and names the anchor", () => {
    const msg = describePurge(points, "sp3");
    expect(msg).toContain("2"); // number of savepoints to be deleted
    expect(msg).toContain("Review Contract"); // the anchor's task_name
  });

  it("reports when nothing would be removed", () => {
    expect(describePurge(points, oldestId)).toContain("nothing");
  });
});

describe("buildPurgeAllRequest", () => {
  it("anchors on a caller-supplied 'now' rather than an element", () => {
    expect(buildPurgeAllRequest(() => "2026-08-21T00:05:00Z")).toEqual({ before: "2026-08-21T00:05:00Z" });
  });

  it("defaults to the real current time", () => {
    const before = Date.now();
    const request = buildPurgeAllRequest();
    const after = Date.now();
    const parsed = Date.parse(request.before);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe("describePurgeAll", () => {
  it("counts every savepoint, including the newest task's own", () => {
    const msg = describePurgeAll(points);
    expect(msg).toContain(String(points.length));
  });

  it("reports when there is nothing to purge", () => {
    expect(describePurgeAll([])).toContain("nothing");
  });
});

describe("agreement with the API's element anchor", () => {
  // The request carries only `before_task_id`, so the server cannot tell which of a task's
  // savepoints was clicked. Both layers therefore have to treat the whole task as the
  // anchor, or the dialog undercounts an irreversible delete. See
  // todos/05-savepoint-purge-api.md and todos/06-savepoint-purge-ui.md.
  it("keeps every savepoint sharing the anchor's task", () => {
    expect(selectPurgedIds(points, "sp2")).toEqual([]);
  });

  it("selects the same set from either savepoint of the anchor task", () => {
    expect(selectPurgedIds(points, "sp1")).toEqual(selectPurgedIds(points, "sp2"));
  });

  it("describes nothing to purge when only the anchor task is older", () => {
    expect(describePurge(points, "sp2")).toContain("nothing");
  });
});
