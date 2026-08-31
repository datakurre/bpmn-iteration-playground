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
      <div class="flex items-center justify-between gap-3 bg-panel border ${
        isCurrent ? "border-accent-border" : "border-line"
      } rounded-lg px-3 py-2 hover:bg-card-hover hover:border-line-highlight transition-colors group">
        <a href="/session?id=${encodeURIComponent(s.id)}" class="min-w-0 flex-1">
          <span class="block font-semibold text-ink truncate">${escapeHtml(s.name || s.id)}</span>
          <span class="block text-xs text-muted truncate">${escapeHtml(projectName(s.project))} &middot; ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"} &middot; ${escapeHtml(relativeTime(s.updatedAt))}</span>
        </a>
        <div class="flex items-center gap-2 shrink-0">
          ${projectBadge}
          ${statusChip(s.status)}
          <button type="button"
                  class="btn-delete-session p-1 rounded text-muted hover:text-danger hover:bg-danger-dim transition-colors"
                  data-session-id="${escapeHtml(s.id)}"
                  data-session-name="${escapeHtml(s.name || s.id)}"
                  title="Delete session">
            <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg>
          </button>
        </div>
      </div>`;
    })
    .join("");

  for (const btn of host.querySelectorAll<HTMLButtonElement>(".btn-delete-session")) {
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.sessionId;
      const name = btn.dataset.sessionName || id;
      if (!id) return;
      if (!confirm(`Delete session "${name}" (${id})? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        const delRes = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (delRes.ok) {
          void loadSessions();
        } else {
          alert(`Failed to delete session: ${delRes.statusText}`);
          btn.disabled = false;
        }
      } catch (err) {
        alert(`Error deleting session: ${err instanceof Error ? err.message : String(err)}`);
        btn.disabled = false;
      }
    };
  }
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

