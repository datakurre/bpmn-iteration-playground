import { describe, it, expect } from "vitest";
import { $, escapeHtml } from "./dom";

describe("$", () => {
  it("returns the element with the given id", () => {
    document.body.innerHTML = '<div id="target">hi</div>';
    expect($("target")?.textContent).toBe("hi");
  });

  it("returns null for a missing id", () => {
    document.body.innerHTML = "";
    expect($("missing")).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("returns an empty string for null/undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("xss") & 'stuff'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;) &amp; &#039;stuff&#039;&lt;/script&gt;",
    );
  });

  it("stringifies non-string values", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(true)).toBe("true");
  });
});
