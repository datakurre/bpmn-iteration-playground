// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeActivitySummaries,
  generateMarkdownReport,
  generateHtmlReport,
  cmdReport,
  cmdExport,
} from "./report.ts";
import type { SessionDetail } from "../studio/types.ts";

describe("CLI reporting and exporting", () => {
  const sampleDetail: SessionDetail = {
    id: "sample-sess-1",
    name: "Dogfood Flake Session",
    project: "/workspace/example",
    status: "completed",
    updatedAt: 1788160840000,
    turnCount: 2,
    graph: readFileSync(resolve(__dirname, "../../workflows/session-default.bpmn"), "utf-8"),
    tokens: [],
    visited: ["start", "call_default", "end"],
    revisions: [
      {
        index: 1,
        at: 1788160840000,
        reason: "spliced flake builder",
        addedElementIds: ["implement_flake", "verify_flake"],
      },
    ],
    stats: {
      totalCostUSD: 0.0073,
      totalTokens: 12500,
      totalInputTokens: 5000,
      totalOutputTokens: 2500,
      totalCacheReadTokens: 5000,
      totalCacheWriteTokens: 0,
      cacheHitRatio: 0.85,
    },
    turns: [
      {
        index: 1,
        activityId: "implement_flake",
        activityName: "Implement Flake",
        harness: "agent:turn",
        stopReason: "stop",
        toolCalls: ["read", "write"],
        startedAt: 1788160800000,
        endedAt: 1788160810000,
        usage: {
          input: 1000,
          output: 500,
          cacheRead: 2000,
          cacheWrite: 0,
          reasoning: 300,
          cost: { input: 0.001, output: 0.003, cacheRead: 0.0001, cacheWrite: 0, total: 0.0041 },
        },
      },
      {
        index: 2,
        activityId: "verify_flake",
        activityName: "Verify Flake",
        harness: "shell",
        stopReason: "stop",
        toolCalls: [],
        startedAt: 1788160810000,
        endedAt: 1788160815000,
        usage: {
          input: 500,
          output: 200,
          cacheRead: 1000,
          cacheWrite: 0,
          cost: { input: 0.0005, output: 0.001, cacheRead: 0.00005, cacheWrite: 0, total: 0.00155 },
        },
      },
    ],
  };

  it("computeActivitySummaries aggregates turns by activity", () => {
    const summaries = computeActivitySummaries(sampleDetail.turns);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.activityId).toBe("implement_flake");
    expect(summaries[0]?.costUSD).toBe(0.0041);
    expect(summaries[0]?.durationMs).toBe(10000);
    expect(summaries[1]?.activityId).toBe("verify_flake");
    expect(summaries[1]?.costUSD).toBe(0.00155);
    expect(summaries[1]?.durationMs).toBe(5000);
  });

  it("generateMarkdownReport produces clean GFM report with activity breakdown and cost", async () => {
    const md = await generateMarkdownReport(sampleDetail);
    expect(md).toContain("# Session Report: Dogfood Flake Session");
    expect(md).toContain("**Total Cost**: **$0.0073**");
    expect(md).toContain("| `implement_flake` | `agent:turn` | 1 |");
    expect(md).toContain("| `verify_flake` | `shell` | 1 |");
    expect(md).toContain("$0.0041");
    expect(md).toContain("spliced flake builder");
  });

  it("generateHtmlReport produces valid HTML document with embedded SVG and metrics", async () => {
    const html = await generateHtmlReport(sampleDetail);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<svg");
    expect(html).toContain("Total Cost");
    expect(html).toContain("$0.0073");
    expect(html).toContain("implement_flake");
  });

  it("cmdExport exports a .bpmn file to SVG", async () => {
    const outFile = resolve(__dirname, "../../scratch-test-export.svg");
    const bpmnFile = resolve(__dirname, "../../workflows/shell-demo.bpmn");
    try {
      const code = await cmdExport(bpmnFile, { out: outFile });
      expect(code).toBe(0);
      expect(existsSync(outFile)).toBe(true);
      const svg = readFileSync(outFile, "utf-8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("turn");
    } finally {
      if (existsSync(outFile)) unlinkSync(outFile);
    }
  });
});
