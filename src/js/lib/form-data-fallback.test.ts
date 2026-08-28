import { describe, it, expect } from "vitest";
import { withDocumentContentFallback } from "./form-data-fallback";

describe("withDocumentContentFallback", () => {
  it("returns an empty object for null/undefined data", () => {
    expect(withDocumentContentFallback(null)).toEqual({});
    expect(withDocumentContentFallback(undefined)).toEqual({});
  });

  it("leaves an explicit document_content untouched", () => {
    const result = withDocumentContentFallback({ document_content: "already set", document_text: "ignored" });
    expect(result.document_content).toBe("already set");
  });

  it("prefers document_text over qa_summary, draft_summary and agent_output.summary", () => {
    const result = withDocumentContentFallback({
      document_text: "text",
      qa_summary: "qa",
      draft_summary: "draft",
      agent_output: { summary: "agent" },
    });
    expect(result.document_content).toBe("text");
  });

  it("falls back through the precedence chain when earlier fields are absent", () => {
    expect(withDocumentContentFallback({ qa_summary: "qa", draft_summary: "draft" }).document_content).toBe("qa");
    expect(withDocumentContentFallback({ draft_summary: "draft" }).document_content).toBe("draft");
    expect(withDocumentContentFallback({ agent_output: { summary: "agent" } }).document_content).toBe("agent");
  });

  it("skips falsy (empty-string) values in the chain, matching the original || semantics", () => {
    const result = withDocumentContentFallback({ document_text: "", qa_summary: "qa" });
    expect(result.document_content).toBe("qa");
  });

  it("leaves document_content undefined when nothing in the chain is set", () => {
    expect(withDocumentContentFallback({ other: "field" }).document_content).toBeUndefined();
  });

  it("does not mutate the input object", () => {
    const input = { document_text: "text" };
    withDocumentContentFallback(input);
    expect(input).not.toHaveProperty("document_content");
  });
});
