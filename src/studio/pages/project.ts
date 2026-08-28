import { $, escapeHtml } from "../../js/lib/dom";
import { connectStudioEvents } from "./live";
import { mountShell, relativeTime, statusChip } from "./shell";
import type { GraphSummary, SessionSummary } from "../types";

async function loadSessions(): Promise<void> {
  const host = $("sessions");
  const empty = $("sessions-empty");
  if (!host) return;
  const res = await fetch("/api/sessions");
  if (!res.ok) return;
  const sessions: SessionSummary[] = await res.json();
  empty?.classList.toggle("hidden", sessions.length > 0);
  host.innerHTML = sessions
    .map(
      (s) => `
      <a href="/session?id=${encodeURIComponent(s.id)}"
         class="flex items-center justify-between gap-3 bg-panel border border-line rounded-lg px-3 py-2 hover:bg-card-hover hover:border-line-highlight transition-colors">
        <span class="min-w-0">
          <span class="block font-semibold text-ink truncate">${escapeHtml(s.name || s.id)}</span>
          <span class="block text-xs text-muted">${s.turnCount} turn${s.turnCount === 1 ? "" : "s"} &middot; ${escapeHtml(relativeTime(s.updatedAt))}</span>
        </span>
        ${statusChip(s.status)}
      </a>`,
    )
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
  await mountShell("project");
  await Promise.all([loadSessions(), loadGraphs()]);

  connectStudioEvents("/ws", (event) => {
    if (event.type === "graphs_changed") void loadGraphs();
    else void loadSessions();
  });
}

void init();
