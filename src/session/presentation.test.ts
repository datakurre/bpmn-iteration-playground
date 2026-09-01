import { describe, expect, it } from "vitest";
import { computeActivitySummaries, sessionDurationMs, sessionItems, sessionToolCallCount } from "./presentation.ts";
import type { SessionDetail } from "../studio/types.ts";

const turn = (index: number) => ({
  index,
  activityId: "step",
  harness: "agent:turn",
  startedAt: 1000,
  endedAt: 2500,
  toolCalls: ["read"],
  usage: {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 0,
    reasoning: 4,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  },
});

describe("session presentation helpers", () => {
  it("uses steps when a session records workflow steps", () => {
    const detail = { turns: [turn(1)], steps: [turn(2)] } as unknown as Pick<SessionDetail, "turns" | "steps">;
    expect(sessionItems(detail).map((item) => item.index)).toEqual([2]);
  });

  it("aggregates the report and studio activity fields identically", () => {
    const summaries = computeActivitySummaries([turn(1), turn(2)]);
    expect(summaries[0]).toMatchObject({ turns: 2, inputTokens: 20, outputTokens: 40, cacheReadTokens: 60, reasoningTokens: 8, costUSD: 0.02, durationMs: 3000 });
    expect(sessionDurationMs([turn(1), turn(2)])).toBe(3000);
    expect(sessionToolCallCount([turn(1), turn(2)])).toBe(2);
  });
});
