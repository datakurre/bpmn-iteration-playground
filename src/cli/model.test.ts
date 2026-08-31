// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProviderAttributionHeaders,
  isCloudflareModel,
  isNvidiaNimModel,
  isOpenCodeModel,
  isOpenRouterModel,
  readConfiguredModel,
} from "./model.ts";

function configWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-agent-config-"));
  const file = join(dir, "config.toml");
  writeFileSync(file, contents);
  return file;
}

describe("readConfiguredModel", () => {
  it("is undefined when the file does not exist", () => {
    expect(readConfiguredModel(join(tmpdir(), "does-not-exist", "config.toml"))).toBeUndefined();
  });

  it("is undefined when [agent] model is left commented out, as init writes it", () => {
    const file = configWith(
      ["# graph-agent settings, shared across every project", "", "[agent]", '# model = "anthropic/claude-sonnet-4-5"', ""].join(
        "\n",
      ),
    );
    expect(readConfiguredModel(file)).toBeUndefined();
  });

  it("reads a quoted model under [agent]", () => {
    const file = configWith(['[agent]', 'model = "opencode-go/gpt-5.6-luna"', ""].join("\n"));
    expect(readConfiguredModel(file)).toBe("opencode-go/gpt-5.6-luna");
  });

  it("reads an unquoted model and trims trailing comments", () => {
    const file = configWith(["[agent]", "model = opencode-go/gpt-5.6-luna  # pinned", ""].join("\n"));
    expect(readConfiguredModel(file)).toBe("opencode-go/gpt-5.6-luna");
  });

  it("only reads model while inside the [agent] section", () => {
    const file = configWith(["[other]", 'model = "wrong/model"', "", "[agent]", ""].join("\n"));
    expect(readConfiguredModel(file)).toBeUndefined();
  });

  it("does not read a model given before any section header", () => {
    const file = configWith(['model = "top-level/model"', "", "[agent]", ""].join("\n"));
    expect(readConfiguredModel(file)).toBeUndefined();
  });
});

describe("getProviderAttributionHeaders", () => {
  it("detects opencode and opencode-go models", () => {
    expect(isOpenCodeModel({ provider: "opencode" })).toBe(true);
    expect(isOpenCodeModel({ provider: "opencode-go" })).toBe(true);
    expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://opencode.ai/zen/go/v1" })).toBe(true);
    expect(isOpenCodeModel({ provider: "anthropic" })).toBe(false);
  });

  it("sets x-opencode-session and x-opencode-client when sessionId is provided for OpenCode models", () => {
    const headers = getProviderAttributionHeaders({ provider: "opencode-go" }, "sess-1234");
    expect(headers).toEqual({
      "x-opencode-session": "sess-1234",
      "x-opencode-client": "graph-agent",
    });
  });

  it("sets x-opencode-session and x-opencode-client for opencode.ai host with custom provider", () => {
    const headers = getProviderAttributionHeaders({ provider: "custom", baseUrl: "https://opencode.ai/zen/go" }, "sess-5678");
    expect(headers).toEqual({
      "x-opencode-session": "sess-5678",
      "x-opencode-client": "graph-agent",
    });
  });

  it("does not set opencode headers when sessionId is omitted", () => {
    expect(getProviderAttributionHeaders({ provider: "opencode-go" })).toBeUndefined();
  });

  it("sets attribution headers for OpenRouter models", () => {
    expect(isOpenRouterModel({ provider: "openrouter" })).toBe(true);
    expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(getProviderAttributionHeaders({ provider: "openrouter" })).toEqual({
      "HTTP-Referer": "https://github.com/datakurre/graph-agent",
      "X-OpenRouter-Title": "graph-agent",
      "X-OpenRouter-Categories": "cli-agent",
    });
  });

  it("sets billing invoke origin header for Nvidia NIM models", () => {
    expect(isNvidiaNimModel({ provider: "nvidia" })).toBe(true);
    expect(getProviderAttributionHeaders({ provider: "nvidia" })).toEqual({
      "X-BILLING-INVOKE-ORIGIN": "graph-agent",
    });
  });

  it("sets User-Agent header for Cloudflare models", () => {
    expect(isCloudflareModel({ provider: "cloudflare-workers-ai" })).toBe(true);
    expect(isCloudflareModel({ provider: "cloudflare-ai-gateway" })).toBe(true);
    expect(getProviderAttributionHeaders({ provider: "cloudflare-ai-gateway" })).toEqual({
      "User-Agent": "graph-agent",
    });
  });

  it("returns undefined for providers without special attribution requirements", () => {
    expect(getProviderAttributionHeaders({ provider: "anthropic" }, "sess-1234")).toBeUndefined();
    expect(getProviderAttributionHeaders({ provider: "openai" })).toBeUndefined();
  });
});

