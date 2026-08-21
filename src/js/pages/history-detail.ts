import "../lib/accordion";
import { $, escapeHtml } from "../lib/dom";
import { initResizer } from "../lib/resizer";
import { fitDiagram, wireZoomControls } from "../lib/bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "../lib/bpmn-types";

interface TaskSummary {
  bpmn_id: string;
  state: string;
}

interface SavePointSummary {
  id: string;
  phase: string;
  task_name: string;
  resume_action: string;
  created_at: string;
  data?: Record<string, unknown>;
}

interface WorkflowState {
  status: string;
  process_id: string;
  data: Record<string, unknown>;
  save_points?: SavePointSummary[];
  tasks?: TaskSummary[];
}

const id = window.__WORKFLOW_ID__ ?? "";
let state: WorkflowState | null = null;
let viewer: BpmnDiagramInstance | null = null;
let savePoints: SavePointSummary[] = [];
let currentSpData: Record<string, unknown> = {};

const sidebarToggleBtn = $("toggle-sidebar");
if (sidebarToggleBtn) {
  sidebarToggleBtn.onclick = () => {
    const sb = $("sidebar");
    const cc = $("canvas-container");
    const vrStacked = $("v-resizer-stacked");
    const isCollapsed = sb?.classList.toggle("!hidden") ?? false;
    if (isCollapsed) {
      cc?.classList.add("!h-[calc(100vh-130px)]", "min-h-[520px]");
      vrStacked?.classList.add("!hidden");
    } else {
      cc?.classList.remove("!h-[calc(100vh-130px)]");
      vrStacked?.classList.remove("!hidden");
    }
    if (viewer) {
      viewer.get("canvas").resized();
      setTimeout(() => fitDiagram(viewer), 150);
    }
  };
}

function setupVerticalResizers(): void {
  const vrStacked = $("v-resizer-stacked");
  const vrDesktop = $("v-resizer-desktop");
  const mainLayout = $("main-layout");
  const canvasContainer = $("canvas-container");
  const onResize = (): void => {
    if (viewer) {
      try {
        viewer.get("canvas").resized();
      } catch {
        // canvas not ready yet
      }
    }
  };
  const onEnd = (): void => {
    if (viewer) {
      try {
        viewer.get("canvas").resized();
        fitDiagram(viewer);
      } catch {
        // canvas not ready yet
      }
    }
  };

  if (vrStacked && canvasContainer) {
    initResizer(vrStacked, canvasContainer, { axis: "vertical", min: 220, max: 1400, onResize, onEnd });
  }
  if (vrDesktop && mainLayout) {
    initResizer(vrDesktop, mainLayout, { axis: "vertical", min: 380, max: 2200, onResize, onEnd });
  }
}
setupVerticalResizers();

function copySpData(): void {
  navigator.clipboard.writeText(JSON.stringify(currentSpData, null, 2));
  alert("Save point variable snapshot copied to clipboard!");
}

function copyFinalData(): void {
  if (state?.data) {
    navigator.clipboard.writeText(JSON.stringify(state.data, null, 2));
    alert("Final workflow variables copied to clipboard!");
  }
}

async function deleteCurrentInstance(): Promise<void> {
  if (confirm("Delete this workflow instance from history?")) {
    const res = await fetch("/api/history/instances/" + id, { method: "DELETE" });
    if (res.ok) location.href = "/history";
  }
}

async function selectSavePoint(spId: string): Promise<void> {
  document.querySelectorAll(".sp-card").forEach((c) => {
    c.classList.remove("border-accent", "bg-card-hover", "shadow-[0_0_0_1px_rgba(94,234,212,0.25)]");
  });
  const card = document.querySelector(`.sp-card[data-sp-id="${spId}"]`);
  if (card) {
    card.classList.add("border-accent", "bg-card-hover", "shadow-[0_0_0_1px_rgba(94,234,212,0.25)]");
  }

  const sp = savePoints.find((p) => p.id === spId);
  if (!sp) return;

  const nameEl = $("active-sp-name");
  if (nameEl) nameEl.textContent = sp.phase;
  const dataEl = $("data-view");
  const res = await fetch(`/instance/${id}/savepoint/${spId}`);
  if (res.ok) {
    const detail = await res.json();
    currentSpData = detail.data;
    if (dataEl) dataEl.textContent = JSON.stringify(detail.data, null, 2);
  } else {
    currentSpData = sp.data || {};
    if (dataEl) dataEl.textContent = JSON.stringify(sp.data || {}, null, 2);
  }
}

async function forkSavePoint(spId: string): Promise<void> {
  const res = await fetch(`/instance/${id}/fork/${spId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ variables: {} }),
  });
  if (res.ok) {
    const next = await res.json();
    location.href = `/instance/${next.workflow_id}`;
  }
}

declare global {
  interface Window {
    copySpData: typeof copySpData;
    copyFinalData: typeof copyFinalData;
    deleteCurrentInstance: typeof deleteCurrentInstance;
    selectSavePoint: typeof selectSavePoint;
    forkSavePoint: typeof forkSavePoint;
  }
}
window.copySpData = copySpData;
window.copyFinalData = copyFinalData;
window.deleteCurrentInstance = deleteCurrentInstance;
window.selectSavePoint = selectSavePoint;
window.forkSavePoint = forkSavePoint;

function renderSavePoints(): void {
  // Real container id is `savepoints`, not the `sp-list` this code used to reference
  // (a pre-existing bug: that id doesn't exist in the template, so this always threw).
  const container = $("savepoints");
  const badge = $("sp-badge");
  if (badge) badge.textContent = String(savePoints.length);
  if (!container) return;
  if (!savePoints.length) {
    container.innerHTML = '<small class="text-muted text-xs">No save points recorded.</small>';
    return;
  }

  container.innerHTML = [...savePoints]
    .reverse()
    .map(
      (sp) => `
    <div class="sp-card p-2 rounded-md bg-card border border-line mb-1.5 text-xs cursor-pointer hover:border-line-highlight hover:bg-card-hover transition-colors" data-sp-id="${escapeHtml(sp.id)}" onclick="selectSavePoint('${escapeHtml(sp.id)}')">
      <strong class="font-semibold text-ink">${escapeHtml(sp.phase)}</strong>
      <small class="text-muted text-[10.5px]">${escapeHtml(sp.task_name)} · ${escapeHtml(new Date(sp.created_at).toLocaleString())}</small>
      <div class="flex justify-between items-center mt-1.5">
        <span class="text-muted text-[10px]">${escapeHtml(sp.resume_action)}</span>
        <button class="btn btn-secondary text-[10px] px-1.5 py-0.5" onclick="event.stopPropagation(); forkSavePoint('${escapeHtml(sp.id)}')">Fork</button>
      </div>
    </div>
  `,
    )
    .join("");

  const last = savePoints[savePoints.length - 1];
  if (last) {
    void selectSavePoint(last.id);
  }
}

async function load(): Promise<void> {
  const [xmlResponse, stateResponse] = await Promise.all([fetch(`/instance/${id}/diagram`), fetch(`/instance/${id}/state`)]);
  const xml = await xmlResponse.text();
  state = await stateResponse.json();
  if (!state) return;

  const ViewerCtor = window.BpmnNavigatedViewer || window.BpmnJS;
  if (!ViewerCtor) return;
  viewer = new (ViewerCtor as new (options: { container: string; additionalModules?: unknown[] }) => BpmnDiagramInstance)({
    container: "#canvas",
    additionalModules: [window.minimapModule].filter(Boolean),
  });

  await viewer.importXML(xml);
  fitDiagram(viewer);

  const statusEl = $("status");
  if (statusEl) {
    statusEl.textContent = state.status;
    statusEl.className = `badge ${state.status}`;
  }
  const processEl = $("process");
  if (processEl) processEl.textContent = state.process_id;
  // Real element is `data-view` (the "Workflow Data" pane); `final-data` never existed
  // in this template, so this write used to throw and abort the rest of load().
  const dataViewEl = $("data-view");
  if (dataViewEl) dataViewEl.textContent = JSON.stringify(state.data, null, 2);

  savePoints = state.save_points || [];
  renderSavePoints();

  if (viewer && state.tasks) {
    const canvas = viewer.get("canvas");
    state.tasks.filter((t) => t.state === "COMPLETED").forEach((t) => canvas.addMarker(t.bpmn_id, "task-active"));
  }
}

wireZoomControls(() => viewer, {
  zoomIn: "ctrl-zoom-in",
  zoomOut: "ctrl-zoom-out",
  fit: "ctrl-zoom-fit",
  reset: "ctrl-zoom-reset",
  minimap: "ctrl-minimap",
});

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
  if (e.key === "m" || e.key === "M") {
    $("ctrl-minimap")?.click();
  } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
    e.preventDefault();
    fitDiagram(viewer);
  } else if (e.altKey && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    $("toggle-sidebar")?.click();
  }
});

void load();
