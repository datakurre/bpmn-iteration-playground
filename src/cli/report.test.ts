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

  it("generateMarkdownReport with verbose: true includes prompts, tool call arguments, and results", async () => {
    const detailWithDetails: SessionDetail = {
      ...sampleDetail,
      turns: [
        {
          ...sampleDetail.turns[0]!,
          prompt: "Please edit default.nix to add the build inputs.",
          response: "I will now edit default.nix with the required packages.",
          toolCallDetails: [
            {
              id: "call_read_1",
              name: "read",
              arguments: { path: "default.nix" },
              result: { content: "{ pkgs ? import <nixpkgs> {} }:\n{}", isError: false },
            },
            {
              id: "call_write_1",
              name: "write",
              arguments: { path: "default.nix", content: "{ pkgs }: pkgs.stdenv.mkDerivation {}" },
              result: { content: "wrote 42 bytes to default.nix", isError: false },
            },
          ],
        },
        {
          ...sampleDetail.turns[1]!,
          inputs: { command: "nix-build" },
          outputs: { exit_code: 0, stdout: "build success", stderr: "" },
        },
      ],
    };
    const md = await generateMarkdownReport(detailWithDetails, { verbose: true });
    expect(md).toContain("Input Prompt");
    expect(md).toContain("Please edit default.nix to add the build inputs.");
    expect(md).toContain("Model Response");
    expect(md).toContain("I will now edit default.nix with the required packages.");
    expect(md).toContain("Tool Call Details");
    expect(md).toContain("<code>read</code> (call_read_1)");
    expect(md).toContain('"path": "default.nix"');
    expect(md).toContain("{ pkgs ? import <nixpkgs> {} }");
    expect(md).toContain("nix-build");
    expect(md).toContain("build success");
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
    expect(html).toContain("Expand All Details");
  });

  it("generateHtmlReport with verbose: true renders collapsible details for prompts, tools, and outputs", async () => {
    const detailWithDetails: SessionDetail = {
      ...sampleDetail,
      turns: [
        {
          ...sampleDetail.turns[0]!,
          prompt: "Please edit default.nix to add the build inputs.",
          response: "I will now edit default.nix with the required packages.",
          toolCallDetails: [
            {
              id: "call_read_1",
              name: "read",
              arguments: { path: "default.nix" },
              result: { content: "{ pkgs ? import <nixpkgs> {} }:\n{}", isError: false },
            },
          ],
        },
        {
          ...sampleDetail.turns[1]!,
          inputs: { command: "nix-build" },
          outputs: { exit_code: 0, stdout: "build ok", stderr: "" },
        },
      ],
    };
    const html = await generateHtmlReport(detailWithDetails, { imageFormat: "raw-svg", verbose: true });
    expect(html).toContain("Input Prompt");
    expect(html).toContain("Please edit default.nix to add the build inputs.");
    expect(html).toContain("Model Response");
    expect(html).toContain("I will now edit default.nix with the required packages.");
    expect(html).toContain("Tool Invocations (1)");
    expect(html).toContain("call_read_1");
    expect(html).toContain("default.nix");
    expect(html).toContain("{ pkgs ? import &lt;nixpkgs&gt; {} }");
    expect(html).toContain("nix-build");
    expect(html).toContain("build ok");
    expect(html).toContain("Collapse All Details");
  });

  it("generateHtmlReport with bash and edit tools renders terminal and diff blocks", async () => {
    const detailWithTools: SessionDetail = {
      ...sampleDetail,
      turns: [
        {
          ...sampleDetail.turns[0]!,
          toolCallDetails: [
            {
              id: "call_bash_1",
              name: "bash",
              arguments: { command: "nix-build --help" },
              result: { content: "Usage: nix-build [OPTION]...", isError: false },
            },
            {
              id: "call_edit_1",
              name: "edit",
              arguments: {
                path: "flake.nix",
                edits: [{ oldText: "foo = 1;", newText: "foo = 2;" }],
              },
              result: { content: "Applied 1 replacement.", isError: false },
            },
          ],
        },
      ],
    };
    const html = await generateHtmlReport(detailWithTools, { imageFormat: "raw-svg", verbose: false });
    expect(html).toContain("Terminal");
    expect(html).toContain("nix-build --help");
    expect(html).toContain("Usage: nix-build");
    expect(html).toContain("flake.nix");
    expect(html).toContain("foo = 1;");
    expect(html).toContain("foo = 2;");
    expect(html).toContain("Applied 1 replacement.");
  });

  it("renderMarkdownToHtml formats fenced code blocks, inline code, and formatting", async () => {
    const { renderMarkdownToHtml } = await import("./report.ts");
    const formatted = renderMarkdownToHtml("Fixed `flake.nix` with:\n\n```bash\nnix run . -- --help\n```\n\nDone.");
    expect(formatted).toContain("<code>flake.nix</code>");
    expect(formatted).toContain("class=\"terminal-card\"");
    expect(formatted).toContain("nix run . -- --help");
    expect(formatted).toContain("Done.");
  });

  it("generateHtmlReport produces valid HTML document with raw SVG if requested", async () => {
    const html = await generateHtmlReport(sampleDetail, { imageFormat: "raw-svg" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<svg");
    expect(html).toContain("Total Cost");
  });

  it("cmdReport generates verbose HTML report file", async () => {
    const { ensurePaths, paths: resolvePaths } = await import("../agent/paths.ts");
    const { SessionStore } = await import("../agent/session-store.ts");
    const { tmpdir } = await import("node:os");
    const { mkdtempSync } = await import("node:fs");

    const home = mkdtempSync(resolve(tmpdir(), "graph-agent-rep-"));
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = resolve(home, "config");
    process.env.XDG_STATE_HOME = resolve(home, "state");

    const p = ensurePaths(resolvePaths(process.env));
    const store = new SessionStore(p, "sess-verbose-test");
    store.create("/workspace/project", "Verbose Test Session");
    store.appendGraph(sampleDetail.graph, "initial", []);
    store.update((meta) => {
      meta.prompt = "Test prompt for verbose report";
      meta.status = "completed";
      meta.turns = [
        {
          index: 1,
          activityId: "llm_step",
          activityName: "LLM Step",
          harness: "agent:turn",
          stopReason: "stop",
          toolCalls: ["read"],
          toolCallDetails: [
            {
              id: "call_1",
              name: "read",
              arguments: { path: "hello.txt" },
              result: { content: "hello world", isError: false },
            },
          ],
          prompt: "Please read hello.txt",
          response: "I read hello.txt and found hello world.",
          summary: "I read hello.txt",
          startedAt: 1000,
          endedAt: 2000,
        },
      ];
    });

    const outHtml = resolve(home, "report.html");
    const outMd = resolve(home, "report.md");
    try {
      const exitCodeHtml = await cmdReport("sess-verbose-test", {
        format: "html",
        out: outHtml,
        verbose: true,
        imageFormat: "raw-svg",
      });
      expect(exitCodeHtml).toBe(0);
      expect(existsSync(outHtml)).toBe(true);
      const htmlContent = readFileSync(outHtml, "utf-8");
      expect(htmlContent).toContain("Please read hello.txt");
      expect(htmlContent).toContain("hello.txt");
      expect(htmlContent).toContain("hello world");
      expect(htmlContent).toContain("Collapse All Details");

      const exitCodeMd = await cmdReport("sess-verbose-test", {
        format: "markdown",
        out: outMd,
        verbose: true,
      });
      expect(exitCodeMd).toBe(0);
      expect(existsSync(outMd)).toBe(true);
      const mdContent = readFileSync(outMd, "utf-8");
      expect(mdContent).toContain("Please read hello.txt");
      expect(mdContent).toContain("hello.txt");
      expect(mdContent).toContain("hello world");
    } finally {
      process.env.XDG_CONFIG_HOME = prevConfig;
      process.env.XDG_STATE_HOME = prevState;
    }
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
