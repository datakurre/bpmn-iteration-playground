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
    const md = await generateMarkdownReport({
      ...sampleDetail,
      prompt: "Package the outline editor with Nix",
      model: "opencode-go/gpt-5.6-luna",
    });
    expect(md).toContain("# Session Report: Dogfood Flake Session");
    expect(md).toContain("**Total Cost**: **$0.0073**");
    expect(md).toContain("Package the outline editor with Nix");
    expect(md).toContain("`opencode-go/gpt-5.6-luna`");
    expect(md).toContain("| `implement_flake` | `T1` | `agent:turn` | 1 |");
    expect(md).toContain("| `verify_flake` | `T2` | `shell` | 1 |");
    expect(md).toContain("[T1] Turn 1: Implement Flake");
    expect(md).toContain("$0.0041");
    expect(md).toContain("spliced flake builder");
  });

  it("generateHtmlReport produces valid HTML document with embedded PNG data URI, prompt, and turn log", async () => {
    const html = await generateHtmlReport({
      ...sampleDetail,
      prompt: "Package the outline editor with Nix",
      model: "opencode-go/gpt-5.6-luna",
    }, { imageFormat: "png" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).toContain("Total Cost");
    expect(html).toContain("$0.0073");
    expect(html).toContain("Package the outline editor with Nix");
    expect(html).toContain("opencode-go/gpt-5.6-luna");
    expect(html).toContain("Turn 1");
    expect(html).toContain("Implement Flake");
    expect(html).toContain("implement_flake");
  });

  it("generateHtmlReport produces valid HTML document with raw SVG if requested", async () => {
    const html = await generateHtmlReport(sampleDetail, { imageFormat: "raw-svg" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<svg");
    expect(html).toContain("Total Cost");
  });

  it("cmdExport exports a .bpmn file to SVG and PNG", async () => {
    const outSvg = resolve(__dirname, "../../scratch-test-export.svg");
    const outPng = resolve(__dirname, "../../scratch-test-export.png");
    const bpmnFile = resolve(__dirname, "../../workflows/shell-demo.bpmn");
    try {
      const codeSvg = await cmdExport(bpmnFile, { out: outSvg });
      expect(codeSvg).toBe(0);
      expect(existsSync(outSvg)).toBe(true);
      const svg = readFileSync(outSvg, "utf-8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("turn");

      const codePng = await cmdExport(bpmnFile, { out: outPng, format: "png" });
      expect(codePng).toBe(0);
      expect(existsSync(outPng)).toBe(true);
      const png = readFileSync(outPng);
      expect(png.length).toBeGreaterThan(100);
      // PNG magic number check
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50);
      expect(png[2]).toBe(0x4e);
      expect(png[3]).toBe(0x47);
    } finally {
      if (existsSync(outSvg)) unlinkSync(outSvg);
      if (existsSync(outPng)) unlinkSync(outPng);
    }
  });
});
