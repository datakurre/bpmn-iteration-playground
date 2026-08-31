import { describe, it, expect, beforeEach, vi } from "vitest";
import { mountShell, relativeTime, statusChip } from "./shell";

beforeEach(() => {
  document.body.innerHTML = "";
  document.title = "Test";
  vi.restoreAllMocks();
});

describe("mountShell", () => {
  it("populates desktop nav and mobile menu links", async () => {
    document.body.innerHTML = `
      <nav id="shell-nav"></nav>
      <div id="mobile-menu" class="hidden"></div>
      <span id="project-name"></span>
      <span id="project-path"></span>
    `;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "/path/to/project", name: "my-project" }),
    } as Response);

    const project = await mountShell("project");

    expect(project).toEqual({ id: "/path/to/project", name: "my-project" });
    expect(document.getElementById("project-name")?.textContent).toBe("my-project");
    expect(document.getElementById("project-path")?.textContent).toBe("/path/to/project");
    expect(document.title).toBe("Test - my-project");

    const desktopNav = document.getElementById("shell-nav");
    expect(desktopNav?.innerHTML).toContain('href="/" class="nav-link active"');
    expect(desktopNav?.innerHTML).toContain('href="/graph" class="nav-link"');
    expect(desktopNav?.innerHTML).toContain('onclick="toggleTheme()"');

    const mobileMenu = document.getElementById("mobile-menu");
    expect(mobileMenu?.innerHTML).toContain('href="/" class="nav-link active"');
    expect(mobileMenu?.innerHTML).toContain('href="/graph" class="nav-link"');
  });

  it("handles fetch failure gracefully", async () => {
    document.body.innerHTML = `
      <nav id="shell-nav"></nav>
      <div id="mobile-menu" class="hidden"></div>
    `;

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const project = await mountShell("graph");
    expect(project).toBeNull();

    const mobileMenu = document.getElementById("mobile-menu");
    expect(mobileMenu?.innerHTML).toContain('href="/graph" class="nav-link active"');
    expect(mobileMenu?.innerHTML).toContain('href="/" class="nav-link"');
  });
});

describe("relativeTime", () => {
  it("formats relative times accurately", () => {
    const now = Date.now();
    expect(relativeTime(now - 10000)).toBe("just now");
    expect(relativeTime(now - 120000)).toBe("2m ago");
    expect(relativeTime(now - 7200000)).toBe("2h ago");
    expect(relativeTime(now - 172800000)).toBe("2d ago");
  });
});

describe("statusChip", () => {
  it("renders status chips with corresponding tone classes", () => {
    expect(statusChip("running")).toContain("text-accent");
    expect(statusChip("wait")).toContain("text-amber");
    expect(statusChip("timer")).toContain("text-amber");
    expect(statusChip("error")).toContain("text-danger");
    expect(statusChip("completed")).toContain("text-muted");
  });
});
