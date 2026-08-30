import { $, escapeHtml } from "../../js/lib/dom";
import { fitDiagram, wireZoomControls } from "../../js/lib/bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "../../js/lib/bpmn-types";
import { connectStudioEvents } from "./live";
import { mountShell, statusChip } from "./shell";
import type { SessionDetail, TurnRecord } from "../types";

let viewer: BpmnDiagramInstance | null = null;
let renderedGraph: string | null = null;
let markedElements: Array<{ id: string; marker: string }> = [];

let modeler: BpmnDiagramInstance | null = null;
let editing = false;
let latestDetail: SessionDetail | null = null;

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
  latestDetail = detail;

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

  // The session graph mutates, so re-import only when the XML actually changed
  // -- and never while a studio edit is in progress, which would yank the
  // diagram out from under whoever is editing it.
  if (viewer && !editing && detail.graph && detail.graph !== renderedGraph) {
    await viewer.importXML(detail.graph);
    renderedGraph = detail.graph;
    markedElements = [];
    fitDiagram(viewer);
  }
  paintTokens(detail);
  renderTurns(detail.turns);
  renderRevisions(detail);
}

function editMsg(message: string, tone: "ok" | "error" | "none" = "none"): void {
  const host = $("edit-msg");
  if (!host) return;
  host.classList.toggle("hidden", tone === "none");
  host.className =
    tone === "none"
      ? "hidden"
      : tone === "ok"
        ? "mb-2 p-2 rounded-md text-xs bg-accent-dim text-accent border border-accent-border"
        : "mb-2 p-2 rounded-md text-xs bg-danger-dim text-danger border border-danger-border";
  host.textContent = message;
}

/** Elements the token has visited or currently stands on -- checkMigration rejects removing or renaming any of these. */
function liveIds(detail: SessionDetail): Set<string> {
  return new Set([...detail.visited, ...detail.tokens]);
}

async function ensureModeler(): Promise<BpmnDiagramInstance | null> {
  if (modeler) return modeler;
  const ModelerCtor = window.BpmnModeler || window.BpmnJS;
  if (!ModelerCtor) return null;
  modeler = new (
    ModelerCtor as new (options: {
      container: string;
      propertiesPanel?: { parent: string };
      additionalModules?: unknown[];
      moddleExtensions?: Record<string, unknown>;
      linting?: { bpmnlint: { config: { rules: Record<string, string> }; resolver: unknown }; active: boolean };
      elementTemplateIconRenderer?: { iconProperty: string };
    }) => BpmnDiagramInstance
  )({
    container: "#editor",
    propertiesPanel: { parent: "#properties-panel" },
    additionalModules: [
      window.BpmnPropertiesPanelModule,
      window.BpmnPropertiesProviderModule,
      window.ElementTemplatesPropertiesProviderModule,
      window.minimapModule,
      window.CreateAppendAnythingModule,
      window.CreateAppendElementTemplatesModule,
      window.BpmnlintModule,
      window.ElementTemplateChooserModule,
      window.ElementTemplateIconRendererModule,
      window.ElementTemplatesExtendModule,
    ].filter(Boolean),
    moddleExtensions: { zeebe: window.zeebeModdleDescriptor || {} },
    linting: window.BpmnlintRecommendedConfig
      ? { bpmnlint: window.BpmnlintRecommendedConfig, active: true }
      : undefined,
    elementTemplateIconRenderer: { iconProperty: "zeebe:modelerTemplateIcon" },
  });
  try {
    const res = await fetch("/api/element-templates");
    if (res.ok) modeler.get("elementTemplatesLoader").setTemplates(await res.json());
  } catch {
    // element templates are optional; the editor works without them
  }
  // Exposed so scripts/verify-editor.mjs (and anything else driving the page)
  // can reach the modeler without scraping internals off the DOM -- the same
  // hook graph.ts's editor already provides.
  (window as unknown as { __modeler?: unknown }).__modeler = modeler;
  return modeler;
}

/** Marks every live element so an edit is at least visually warned before it is attempted -- checkMigration is the actual enforcement. */
function markLocked(instance: BpmnDiagramInstance, ids: Set<string>): void {
  const canvas = instance.get("canvas");
  for (const id of ids) {
    try {
      canvas.addMarker(id, "ga-locked");
    } catch {
      // not in this revision
    }
  }
}

async function enterEdit(): Promise<void> {
  if (!latestDetail) return;
  const instance = await ensureModeler();
  if (!instance) return editMsg("Editor failed to load.", "error");

  editing = true;
  $("viewer")?.classList.add("hidden");
  $("editor")?.classList.remove("hidden");
  $("properties-container")?.classList.remove("hidden");
  $("properties-container")?.classList.add("flex");
  $("edit-btn")?.classList.add("hidden");
  $("save-btn")?.classList.remove("hidden");
  $("cancel-btn")?.classList.remove("hidden");
  editMsg("", "none");

  await instance.importXML(latestDetail.graph);
  markLocked(instance, liveIds(latestDetail));
  fitDiagram(instance);
}

function exitEdit(): void {
  editing = false;
  $("editor")?.classList.add("hidden");
  $("properties-container")?.classList.add("hidden");
  $("properties-container")?.classList.remove("flex");
  $("viewer")?.classList.remove("hidden");
  $("edit-btn")?.classList.remove("hidden");
  $("save-btn")?.classList.add("hidden");
  $("cancel-btn")?.classList.add("hidden");
  // Force the viewer to pick up whatever is now current, including a save
  // that just landed.
  renderedGraph = null;
  void refresh();
}

async function saveEdit(): Promise<void> {
  if (!modeler) return;
  const { xml } = await modeler.saveXML({ format: true });
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/graph`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xml }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { error?: string; removed?: string[] };
    editMsg(
      body.removed?.length
        ? `Cannot save: ${body.error} (${body.removed.join(", ")})`
        : (body.error ?? "Cannot save: rejected"),
      "error",
    );
    return;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    editMsg(`Save failed: ${body.error ?? res.statusText}`, "error");
    return;
  }
  editMsg("Saved as a new revision.", "ok");
  exitEdit();
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

  const editBtn = $("edit-btn");
  if (editBtn) editBtn.onclick = () => void enterEdit();
  const cancelBtn = $("cancel-btn");
  if (cancelBtn) cancelBtn.onclick = () => exitEdit();
  const saveBtn = $("save-btn");
  if (saveBtn) saveBtn.onclick = () => void saveEdit();

  connectStudioEvents("/ws", (event) => {
    if (event.type === "session_changed" && event.sessionId !== sessionId) return;
    if (event.type === "graphs_changed") return;
    void refresh();
  });
}

void init();
