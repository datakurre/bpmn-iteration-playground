import { describe, it, expect } from "vitest";
import { toggleAcc, handleAccKey } from "./accordion";

function setupAccordion(): { header: HTMLElement; body: HTMLElement } {
  document.body.innerHTML = `
    <div class="acc-header" id="header"></div>
    <div class="acc-body" id="body"></div>
  `;
  return {
    header: document.getElementById("header") as HTMLElement,
    body: document.getElementById("body") as HTMLElement,
  };
}

describe("toggleAcc", () => {
  it("toggles .collapsed on both the header and its next sibling", () => {
    const { header, body } = setupAccordion();
    toggleAcc(header);
    expect(header.classList.contains("collapsed")).toBe(true);
    expect(body.classList.contains("collapsed")).toBe(true);

    toggleAcc(header);
    expect(header.classList.contains("collapsed")).toBe(false);
    expect(body.classList.contains("collapsed")).toBe(false);
  });

  it("accepts an element id as well as an element", () => {
    const { body } = setupAccordion();
    toggleAcc("header");
    expect(body.classList.contains("collapsed")).toBe(true);
  });

  it("does nothing for an unknown id", () => {
    setupAccordion();
    expect(() => toggleAcc("does-not-exist")).not.toThrow();
  });
});

describe("handleAccKey", () => {
  it("toggles on Enter and Space, and prevents default", () => {
    const { header, body } = setupAccordion();
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    handleAccKey(enter, header);
    expect(body.classList.contains("collapsed")).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("ignores other keys", () => {
    const { header, body } = setupAccordion();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    handleAccKey(tab, header);
    expect(body.classList.contains("collapsed")).toBe(false);
    expect(tab.defaultPrevented).toBe(false);
  });
});
