import { $, escapeHtml } from "../../js/lib/dom";
import { connectStudioEvents } from "./live";
import type { SessionSummary, WorkflowSummary } from "../types";

function statusClass(status: SessionSummary["status"]): string {
  switch (status) {
    case "running":
      return "text-accent border-accent-border bg-accent-dim";
    case "wait":
    case "timer":
      return "text-amber border-amber-border bg-amber-dim";
    case "error":
      return "text-danger border-danger-border bg-danger-dim";
    default:
      return "text-muted border-line bg-panel-header";
  }
}

function card(inner: string): string {
  return `<div class="bg-panel border border-line rounded-lg px-3 py-2 hover:bg-card-hover transition-colors">${inner}</div>`;
}

async function loadSessions(): Promise<void> {
  const host = $("sessions");
  const empty = $("sessions-empty");
  if (!host) return;
  const res = await fetch("/api/sessions");
  if (!res.ok) return;
  const sessions: SessionSummary[] = await res.json();
  empty?.classList.toggle("hidden", sessions.length > 0);
  host.innerHTML = sessions
    .map((s) =>
      card(`
        <a href="/session?id=${encodeURIComponent(s.id)}" class="flex items-center justify-between gap-3">
          <span class="min-w-0">
            <span class="block font-semibold text-ink truncate">${escapeHtml(s.name || s.id)}</span>
            <span class="block text-xs text-muted font-mono truncate">${escapeHtml(s.id)}</span>
          </span>
          <span class="shrink-0 flex items-center gap-2">
            <span class="text-xs text-muted">${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}</span>
            <span class="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded border ${statusClass(s.status)}">${s.status}</span>
          </span>
        </a>`),
    )
    .join("");
}

async function loadWorkflows(): Promise<void> {
  const host = $("workflows");
  if (!host) return;
  const res = await fetch("/api/templates");
  if (!res.ok) return;
  const workflows: WorkflowSummary[] = await res.json();
  host.innerHTML = workflows
    .map((w) =>
      card(`
        <a href="/editor?workflow=${encodeURIComponent(w.id)}" class="flex items-center justify-between gap-3">
          <span class="font-semibold text-ink truncate">${escapeHtml(w.name)}</span>
          <span class="text-xs text-muted font-mono shrink-0">${escapeHtml(w.id)}.bpmn</span>
        </a>`),
    )
    .join("");
}

void loadSessions();
void loadWorkflows();

connectStudioEvents("/ws", (event) => {
  if (event.type === "sessions_changed" || event.type === "session_changed") void loadSessions();
});
