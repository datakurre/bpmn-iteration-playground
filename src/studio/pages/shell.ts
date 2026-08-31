import { $, escapeHtml } from "../../js/lib/dom";
import { updateThemeIcons, initMobileMenu } from "../../js/lib/theme";
import type { ProjectInfo } from "../types";

/**
 * Every page is scoped to one project, so every page says which. The header is
 * rendered from the server's answer rather than hard-coded, so a studio opened
 * in the wrong directory is obvious at a glance.
 */
export async function mountShell(active: "project" | "session" | "graph"): Promise<ProjectInfo | null> {
  updateThemeIcons();
  initMobileMenu();

  const links = ["project", "graph"].map((page) => {
    const href = page === "project" ? "/" : "/graph";
    const label = page === "project" ? "Sessions" : "Graphs";
    const on = active === page || (active === "session" && page === "project");
    return `<a href="${href}" class="nav-link${on ? " active" : ""}">${label}</a>`;
  });

  const host = $("shell-nav");
  if (host) {
    host.innerHTML = [
      ...links,
      `<button onclick="toggleTheme()" class="btn btn-secondary text-xs px-2 py-1 ml-1" title="Toggle light/dark theme"><span class="theme-toggle-icon">&#9728;</span></button>`,
    ].join("");
    updateThemeIcons();
  }

  const mobileHost = $("mobile-menu");
  if (mobileHost) {
    mobileHost.innerHTML = links.join("");
  }

  try {
    const res = await fetch("/api/project");
    if (!res.ok) return null;
    const project: ProjectInfo = await res.json();
    const name = $("project-name");
    if (name) name.textContent = project.name;
    const path = $("project-path");
    if (path) {
      path.textContent = project.id;
      path.title = project.id;
    }
    document.title = `${document.title} - ${project.name}`;
    return project;
  } catch {
    return null;
  }
}

export function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function statusChip(status: string): string {
  const tone =
    status === "running"
      ? "text-accent border-accent-border bg-accent-dim"
      : status === "wait" || status === "timer"
        ? "text-amber border-amber-border bg-amber-dim"
        : status === "error"
          ? "text-danger border-danger-border bg-danger-dim"
          : "text-muted border-line bg-panel-header";
  return `<span class="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded border ${tone}">${escapeHtml(status)}</span>`;
}
