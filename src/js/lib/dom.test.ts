import { describe, it, expect } from "vitest";
import { $, escapeHtml, renderList } from "./dom";

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

describe("renderList", () => {
  it("joins each item's template into the container", () => {
    const container = document.createElement("div");
    renderList(container, ["a", "b"], (item) => `<span>${item}</span>`);
    expect(container.innerHTML).toBe("<span>a</span><span>b</span>");
  });

  it("renders the empty string by default when there are no items", () => {
    const container = document.createElement("div");
    container.innerHTML = "<span>stale</span>";
    renderList(container, [], () => "<span>unused</span>");
    expect(container.innerHTML).toBe("");
  });

  it("renders the given empty-state markup when there are no items", () => {
    const container = document.createElement("div");
    renderList(container, [], () => "", '<p class="empty">nothing here</p>');
    expect(container.innerHTML).toBe('<p class="empty">nothing here</p>');
  });
});
