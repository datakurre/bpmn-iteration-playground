import { $, escapeHtml } from "../../js/lib/dom";
import { fitDiagram, wireZoomControls } from "../../js/lib/bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "../../js/lib/bpmn-types";
import { connectStudioEvents } from "./live";
import { mountShell, statusChip } from "./shell";
import type { SessionDetail, TurnRecord } from "../types";

let viewer: BpmnDiagramInstance | null = null;
let renderedGraph: string | null = null;
let markedElements: Array<{ id: string; marker: string }> = [];

const sessionId = new URLSearchParams(location.search).get("id") ?? "";

/**
 * Where the token stands, and where it has been. Markers are cleared first: the
 * graph mutates between revisions, so yesterday's markers may point at elements
 * that no longer exist.
 */
function paintTokens(detail: SessionDetail): void {
  if (!viewer) return;
  const canvas = viewer.get("canvas");
  for (const { id, marker } of markedElements) {
    try {
      canvas.removeMarker(id, marker);
    } catch {
      // element gone in a later revision; nothing to clear
    }
  }
  markedElements = [];

  const mark = (ids: string[], marker: string): void => {
    for (const id of ids) {
      try {
        canvas.addMarker(id, marker);
        markedElements.push({ id, marker });
      } catch {
        // spliced out since this turn ran
      }
    }
  };
  mark(detail.visited, "ga-visited");
  mark(detail.tokens, "ga-token");
}

function usageChip(turn: TurnRecord): string {
  if (!turn.usage) return "";
  const { input, output, cacheRead } = turn.usage;
  // cacheRead is the number worth watching: a graph-coordinated run reuses one
  // Pi session, so every turn after the first should read most of its prefix
  // from cache. A run of zeros means the prefix is being invalidated somewhere.
  const cached = cacheRead > 0;
  return `<span class="font-mono text-[10px] px-1 py-0.5 rounded border ${
    cached ? "text-accent border-accent-border bg-accent-dim" : "text-muted border-line bg-panel-header"
  }" title="input ${input}, output ${output}, cache read ${cacheRead}">${cached ? `cache ${cacheRead}` : "uncached"}</span>`;
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
      return `
        <article class="px-3 py-2 border-b border-line-subtle" data-activity="${escapeHtml(turn.activityId)}">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-semibold text-ink truncate">${turn.index}. ${escapeHtml(turn.activityName || turn.activityId)}</span>
            <span class="flex items-center gap-1 shrink-0">
              ${usageChip(turn)}
              ${turn.stopReason ? `<span class="text-[10px] uppercase tracking-wide font-bold text-muted">${escapeHtml(turn.stopReason)}</span>` : ""}
            </span>
          </div>
          <div class="font-mono text-[10px] text-muted">${escapeHtml(turn.activityId)}${turn.harness ? ` &middot; ${escapeHtml(turn.harness)}` : ""}</div>
          ${turn.summary ? `<div class="mt-1 text-ink-secondary">${escapeHtml(turn.summary)}</div>` : ""}
          ${tools}
          ${turn.error ? `<div class="mt-1 text-danger">${escapeHtml(turn.error)}</div>` : ""}
        </article>`;
    })
    .join("");

  // Clicking a turn centres the node that produced it.
  for (const article of host.querySelectorAll<HTMLElement>("article[data-activity]")) {
    article.onclick = () => {
      const id = article.dataset.activity;
      if (!id || !viewer) return;
      try {
        const element = viewer.get("elementRegistry").get(id);
        if (element) viewer.get("canvas").scrollToElement(element);
      } catch {
        // element no longer in the current revision
      }
    };
  }
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
  if (!res.ok) {
    const title = $("session-title");
    if (title) title.textContent = "Unknown session";
    return;
  }
  const detail: SessionDetail = await res.json();

  const title = $("session-title");
  if (title) title.textContent = detail.name || detail.id;
  const status = $("session-status");
  if (status) status.innerHTML = statusChip(detail.status);
  const meta = $("session-meta");
  if (meta) {
    meta.textContent = `${detail.turnCount} turns · ${detail.revisions.length} graph revision${
      detail.revisions.length === 1 ? "" : "s"
    }`;
  }

  // The session graph mutates, so re-import only when the XML actually changed.
  if (viewer && detail.graph && detail.graph !== renderedGraph) {
    await viewer.importXML(detail.graph);
    renderedGraph = detail.graph;
    markedElements = [];
    fitDiagram(viewer);
  }
  paintTokens(detail);
  renderTurns(detail.turns);
  renderRevisions(detail);
}

async function init(): Promise<void> {
  await mountShell("session");

  const ViewerCtor = window.BpmnNavigatedViewer || window.BpmnJS;
  if (ViewerCtor) {
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
  }

  await refresh();

  connectStudioEvents("/ws", (event) => {
    if (event.type === "session_changed" && event.sessionId !== sessionId) return;
    if (event.type === "graphs_changed") return;
    void refresh();
  });
}

void init();
