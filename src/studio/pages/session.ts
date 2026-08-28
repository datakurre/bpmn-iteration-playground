import { $, escapeHtml } from "../../js/lib/dom";
import { fitDiagram, wireZoomControls } from "../../js/lib/bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "../../js/lib/bpmn-types";
import { connectStudioEvents } from "./live";
import type { SessionDetail, TurnRecord } from "../types";

let viewer: BpmnDiagramInstance | null = null;
let renderedGraph: string | null = null;

const sessionId = new URLSearchParams(location.search).get("id") ?? "";

function markers(detail: SessionDetail): void {
  if (!viewer) return;
  const canvas = viewer.get("canvas");
  for (const id of detail.visited) {
    try {
      canvas.addMarker(id, "ga-visited");
    } catch {
      // the element may have been spliced out of a later revision
    }
  }
  for (const id of detail.tokens) {
    try {
      canvas.addMarker(id, "ga-token");
    } catch {
      // as above
    }
  }
}

function renderTurns(turns: TurnRecord[]): void {
  const host = $("turns");
  if (!host) return;
  if (turns.length === 0) {
    host.innerHTML = `<p class="px-3 py-4 text-muted">No turns yet.</p>`;
    return;
  }
  host.innerHTML = turns
    .map((turn) => {
      const tools = turn.toolCalls?.length
        ? `<div class="mt-1 flex flex-wrap gap-1">${turn.toolCalls
            .map(
              (t) =>
                `<span class="font-mono text-[10px] px-1 py-0.5 rounded bg-sky-dim text-sky border border-sky-border">${escapeHtml(t)}</span>`,
            )
            .join("")}</div>`
        : "";
      const stop = turn.stopReason
        ? `<span class="text-[10px] uppercase tracking-wide font-bold text-muted">${escapeHtml(turn.stopReason)}</span>`
        : "";
      const error = turn.error
        ? `<div class="mt-1 text-danger">${escapeHtml(turn.error)}</div>`
        : "";
      return `
        <article class="px-3 py-2 border-b border-line-subtle">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-semibold text-ink">${turn.index}. ${escapeHtml(turn.activityName || turn.activityId)}</span>
            ${stop}
          </div>
          <div class="font-mono text-[10px] text-muted">${escapeHtml(turn.activityId)}${turn.harness ? ` &middot; ${escapeHtml(turn.harness)}` : ""}</div>
          ${turn.summary ? `<div class="mt-1 text-ink-secondary">${escapeHtml(turn.summary)}</div>` : ""}
          ${tools}
          ${error}
        </article>`;
    })
    .join("");
}

function renderRevisions(detail: SessionDetail): void {
  const host = $("revisions");
  if (!host) return;
  if (detail.revisions.length === 0) {
    host.innerHTML = `<p class="px-3 py-3 text-muted">Graph unchanged since the session started.</p>`;
    return;
  }
  host.innerHTML = detail.revisions
    .map(
      (rev) => `
      <div class="px-3 py-2 border-b border-line-subtle">
        <div class="flex items-baseline justify-between gap-2">
          <span class="font-semibold text-ink">r${rev.index}</span>
          <span class="text-[10px] text-muted">${new Date(rev.at).toLocaleTimeString()}</span>
        </div>
        <div class="text-ink-secondary">${escapeHtml(rev.reason)}</div>
        ${
          rev.addedElementIds.length
            ? `<div class="mt-1 font-mono text-[10px] text-accent">+ ${rev.addedElementIds.map(escapeHtml).join(", ")}</div>`
            : ""
        }
      </div>`,
    )
    .join("");
}

async function refresh(): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) return;
  const detail: SessionDetail = await res.json();

  const title = $("session-title");
  if (title) title.textContent = detail.name || detail.id;
  const meta = $("session-meta");
  if (meta) {
    meta.textContent = `${detail.status} · ${detail.turnCount} turns · ${detail.revisions.length} graph revision${detail.revisions.length === 1 ? "" : "s"}`;
  }

  // The session graph mutates, so re-import whenever the XML actually changed.
  if (viewer && detail.graph !== renderedGraph) {
    await viewer.importXML(detail.graph);
    renderedGraph = detail.graph;
    fitDiagram(viewer);
  }
  markers(detail);
  renderTurns(detail.turns);
  renderRevisions(detail);
}

async function init(): Promise<void> {
  const ViewerCtor = window.BpmnNavigatedViewer || window.BpmnJS;
  if (!ViewerCtor) return;
  viewer = new (ViewerCtor as new (options: {
    container: string;
    additionalModules?: unknown[];
  }) => BpmnDiagramInstance)({
    container: "#viewer",
    additionalModules: [window.minimapModule].filter(Boolean),
  });

  wireZoomControls(() => viewer, {
    zoomIn: "ctrl-zoom-in",
    zoomOut: "ctrl-zoom-out",
    fit: "ctrl-zoom-fit",
    reset: "ctrl-zoom-reset",
    minimap: "ctrl-minimap",
  });

  await refresh();

  connectStudioEvents("/ws", (event) => {
    if (event.type === "session_changed" && event.sessionId !== sessionId) return;
    void refresh();
  });
}

void init();
