// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguredModel } from "./model.ts";

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
