import { describe, it, expect, beforeEach } from "vitest";
import { toggleTheme, updateThemeIcons, initMobileMenu } from "./theme";

beforeEach(() => {
  document.documentElement.classList.remove("dark");
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("toggleTheme", () => {
  it("adds the dark class and persists the choice", () => {
    toggleTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.theme).toBe("dark");
  });

  it("removes the dark class on a second call", () => {
    toggleTheme();
    toggleTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.theme).toBe("light");
  });

  it("is exposed on window for inline onclick handlers", () => {
    expect(window.toggleTheme).toBe(toggleTheme);
  });
});

describe("updateThemeIcons", () => {
  it("shows the sun/Dark label in light mode", () => {
    document.body.innerHTML = '<span class="theme-toggle-icon"></span><span class="theme-toggle-text"></span>';
    updateThemeIcons();
    expect(document.querySelector(".theme-toggle-icon")?.textContent).toBe("🌙");
    expect(document.querySelector(".theme-toggle-text")?.textContent).toBe("Dark");
  });

  it("shows the moon/Light label in dark mode", () => {
    document.documentElement.classList.add("dark");
    document.body.innerHTML = '<span class="theme-toggle-icon"></span><span class="theme-toggle-text"></span>';
    updateThemeIcons();
    expect(document.querySelector(".theme-toggle-icon")?.textContent).toBe("☀️");
    expect(document.querySelector(".theme-toggle-text")?.textContent).toBe("Light");
  });

  it("updates every matching element", () => {
    document.body.innerHTML = '<span class="theme-toggle-icon"></span><span class="theme-toggle-icon"></span>';
    updateThemeIcons();
    document.querySelectorAll(".theme-toggle-icon").forEach((el) => expect(el.textContent).toBe("🌙"));
  });
});

describe("initMobileMenu", () => {
  it("toggles the menu open on button click and closes on outside click", () => {
    document.body.innerHTML = '<button id="mobile-menu-btn"></button><div id="mobile-menu" class="hidden"></div>';
    initMobileMenu();
    const btn = document.getElementById("mobile-menu-btn") as HTMLElement;
    const menu = document.getElementById("mobile-menu") as HTMLElement;

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.classList.contains("hidden")).toBe(false);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("does nothing when the elements are missing", () => {
    document.body.innerHTML = "";
    expect(() => initMobileMenu()).not.toThrow();
  });
});
