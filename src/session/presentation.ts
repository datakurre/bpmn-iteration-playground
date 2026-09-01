import type { SessionDetail, TurnRecord } from "../studio/types.ts";

export interface ActivitySummary {
  activityId: string;
  activityName: string;
  harness: string;
  turns: number;
  turnIndices: number[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  costUSD: number;
  durationMs: number;
}

export function sessionItems(detail: Pick<SessionDetail, "turns" | "steps">): TurnRecord[] {
  return detail.steps && detail.steps.length > 0 ? detail.steps : detail.turns;
}

export function computeActivitySummaries(turns: TurnRecord[]): ActivitySummary[] {
  const map = new Map<string, ActivitySummary>();
  for (const turn of turns) {
    const existing = map.get(turn.activityId) || {
      activityId: turn.activityId,
      activityName: turn.activityName || turn.activityId,
      harness: turn.harness || "-",
      turns: 0,
      turnIndices: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
      durationMs: 0,
    };
    existing.turns += 1;
    existing.turnIndices.push(turn.index);
    if (turn.usage) {
      existing.inputTokens += turn.usage.input || 0;
      existing.outputTokens += turn.usage.output || 0;
      existing.cacheReadTokens += turn.usage.cacheRead || 0;
      existing.reasoningTokens += turn.usage.reasoning || 0;
      existing.costUSD += turn.usage.cost?.total || 0;
    }
    if (turn.startedAt && turn.endedAt) existing.durationMs += turn.endedAt - turn.startedAt;
    map.set(turn.activityId, existing);
  }
  return [...map.values()];
}

export function sessionDurationMs(turns: TurnRecord[]): number {
  return turns.reduce((total, turn) => total + (turn.startedAt && turn.endedAt ? turn.endedAt - turn.startedAt : 0), 0);
}

export function sessionToolCallCount(turns: TurnRecord[]): number {
  return turns.reduce((total, turn) => total + (turn.toolCallDetails?.length || turn.toolCalls?.length || 0), 0);
}

export function formatCost(usd: number): string {
  if (!usd || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
