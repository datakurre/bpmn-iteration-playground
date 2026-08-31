import { $, escapeHtml } from "../../js/lib/dom";
import { connectStudioEvents } from "./live";
import { mountShell, projectName, relativeTime, statusChip } from "./shell";
import type { GraphSummary, ProjectInfo, SessionSummary } from "../types";

let currentProject: ProjectInfo | null = null;

async function loadSessions(): Promise<void> {
  const host = $("sessions");
  const empty = $("sessions-empty");
  if (!host) return;
  const res = await fetch("/api/sessions");
  if (!res.ok) return;
  const sessions: SessionSummary[] = await res.json();
  empty?.classList.toggle("hidden", sessions.length > 0);
  host.innerHTML = sessions
    .map((s) => {
      const isCurrent = Boolean(currentProject && s.project === currentProject.id);
      const projectBadge = isCurrent
        ? `<span class="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded border text-accent border-accent-border bg-accent-dim">this project</span>`
        : `<span class="text-[10px] text-muted border border-line bg-panel-header px-1.5 py-0.5 rounded font-mono truncate max-w-[140px]" title="${escapeHtml(s.project || "")}">${escapeHtml(projectName(s.project))}</span>`;

      return `
      <a href="/session?id=${encodeURIComponent(s.id)}"
         class="flex items-center justify-between gap-3 bg-panel border ${
           isCurrent ? "border-accent-border" : "border-line"
         } rounded-lg px-3 py-2 hover:bg-card-hover hover:border-line-highlight transition-colors">
        <span class="min-w-0">
          <span class="block font-semibold text-ink truncate">${escapeHtml(s.name || s.id)}</span>
          <span class="block text-xs text-muted truncate">${escapeHtml(projectName(s.project))} &middot; ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"} &middot; ${escapeHtml(relativeTime(s.updatedAt))}</span>
        </span>
        <div class="flex items-center gap-2 shrink-0">
          ${projectBadge}
          ${statusChip(s.status)}
        </div>
      </a>`;
    })
    .join("");
}

async function loadGraphs(): Promise<void> {
  const host = $("graphs");
  if (!host) return;
  const res = await fetch("/api/graphs");
  if (!res.ok) return;
  const graphs: GraphSummary[] = await res.json();
  host.innerHTML = graphs
    .map(
      (g) => `
      <a href="/graph?id=${encodeURIComponent(g.id)}"
         class="flex items-center justify-between gap-3 bg-panel border border-line rounded-lg px-3 py-2 hover:bg-card-hover hover:border-line-highlight transition-colors">
        <span class="font-semibold text-ink truncate">${escapeHtml(g.name)}</span>
        <span class="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded border ${
          g.source === "bundled" ? "text-muted border-line bg-panel-header" : "text-sky border-sky-border bg-sky-dim"
        }">${g.source}</span>
      </a>`,
    )
    .join("");
}

async function init(): Promise<void> {
  currentProject = await mountShell("project");
  await Promise.all([loadSessions(), loadGraphs()]);

  connectStudioEvents("/ws", (event) => {
    if (event.type === "graphs_changed") void loadGraphs();
    else void loadSessions();
  });
}

void init();

