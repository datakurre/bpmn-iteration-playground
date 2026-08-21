import "../lib/accordion";
import { $, escapeHtml } from "../lib/dom";
import { initResizer } from "../lib/resizer";
import { fitDiagram, wireZoomControls } from "../lib/bpmn-viewer-controls";
import { withDocumentContentFallback } from "../lib/form-data-fallback";
import { createBackoffScheduler } from "../lib/websocket";
import { buildPurgeRequest, describePurge } from "../lib/savepoint-purge";
import type { BpmnDiagramInstance } from "../lib/bpmn-types";
import type { FormInstance } from "../types/globals";


interface JobStatus {
  status: string;
}

interface TaskSummary {
  id: string;
  bpmn_id: string;
  name?: string;
  type?: string;
  state: string;
}

interface SavePointSummary {
  id: string;
  phase: string;
  task_id: string;
  task_name: string;
  created_at: string;
}

interface WorkspaceFile {
  path: string;
  name?: string;
  size: number;
}

interface WorkspaceMetadata {
  files?: WorkspaceFile[];
  total_size?: number;
}

interface WorkflowState {
  workflow_id: string;
  parent_workflow_id?: string;
  process_id: string;
  status: string;
  tasks: TaskSummary[];
  jobs?: Record<string, JobStatus>;
  save_points?: SavePointSummary[];
  data: Record<string, unknown> & { workspace_metadata?: WorkspaceMetadata };
}

const id = window.__WORKFLOW_ID__ ?? "";
let state: WorkflowState | null = null;
let reviewTask: TaskSummary | undefined;
let viewer: BpmnDiagramInstance | null = null;
let formViewer: FormInstance | null = null;
let ws: WebSocket | null = null;

function copyData(): void {
  if (state?.data) {
    navigator.clipboard.writeText(JSON.stringify(state.data, null, 2));
    alert("Workflow data JSON copied to clipboard!");
  }
}

declare global {
  interface Window {
    copyData: typeof copyData;
  }
}
window.copyData = copyData;

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

  if (vrStacked && canvasContainer) {
    initResizer(vrStacked, canvasContainer, {
      axis: "vertical",
      min: 220,
      max: 1400,
      onResize: () => {
        if (viewer) {
          try {
            viewer.get("canvas").resized();
          } catch {
            // canvas not ready yet
          }
        }
      },
      onEnd: () => {
        if (viewer) {
          try {
            viewer.get("canvas").resized();
            fitDiagram(viewer);
          } catch {
            // canvas not ready yet
          }
        }
      },
    });
  }
  if (vrDesktop && mainLayout) {
    initResizer(vrDesktop, mainLayout, {
      axis: "vertical",
      min: 380,
      max: 2200,
      onResize: () => {
        if (viewer) {
          try {
            viewer.get("canvas").resized();
          } catch {
            // canvas not ready yet
          }
        }
      },
      onEnd: () => {
        if (viewer) {
          try {
            viewer.get("canvas").resized();
            fitDiagram(viewer);
          } catch {
            // canvas not ready yet
          }
        }
      },
    });
  }
}
setupVerticalResizers();

function renderState(next: WorkflowState): void {
  state = next;
  const statusEl = $("status");
  if (statusEl) {
    statusEl.textContent = next.status;
    statusEl.className = `badge ${next.status}`;
  }
  const processEl = $("process");
  if (processEl) processEl.textContent = next.process_id;

  const parentEl = $("parent-workflow");
  if (parentEl) {
    if (next.parent_workflow_id) {
      parentEl.classList.remove("hidden");
      parentEl.className = "inline-block";
      parentEl.innerHTML = `<a href="/instance/${encodeURIComponent(next.parent_workflow_id)}" class="badge bg-[#2b3b51] text-white no-underline">⬑ Parent</a>`;
    } else {
      parentEl.classList.add("hidden");
    }
  }

  const tasksBadge = $("tasks-badge");
  if (tasksBadge) tasksBadge.textContent = String(next.tasks.length);
  const tasksEl = $("tasks");
  if (tasksEl) {
    tasksEl.innerHTML = [...next.tasks]
      .reverse()
      .map((t) => {
        const isFailed = next.jobs?.[t.id]?.status === "failed";
        const retry = isFailed ? `<button class="btn btn-danger px-2 py-0.5 text-[10px]" data-retry="${escapeHtml(t.id)}">Retry</button>` : "";
        return `
      <div class="p-2 rounded-md bg-card border border-line mb-1.5 text-xs hover:border-line-highlight hover:bg-card-hover transition-colors">
        <div class="flex justify-between items-center gap-2">
          <div class="font-semibold text-ink text-[12.5px]">${escapeHtml(t.name || t.bpmn_id)}</div>
          <span class="badge ${escapeHtml(t.state.toLowerCase())}">${escapeHtml(t.state)}</span>
        </div>
        <div class="text-muted text-[10.5px] font-mono mt-0.5">${escapeHtml(t.id)} · ${escapeHtml(t.type || "Task")}</div>
        ${retry ? `<div class="mt-1.5">${retry}</div>` : ""}
      </div>`;
      })
      .join("");
  }

  document.querySelectorAll<HTMLButtonElement>("[data-retry]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const response = await fetch(`/instance/${id}/retry/${button.dataset.retry}`, { method: "POST" });
      if (response.ok) {
        renderState(await response.json());
      }
    };
  });

  const spList = [...(next.save_points || [])].reverse();
  const savepointsBadge = $("savepoints-badge");
  if (savepointsBadge) savepointsBadge.textContent = String(spList.length);
  const savepointsEl = $("savepoints");
  if (savepointsEl) {
    savepointsEl.innerHTML = spList.length
      ? spList
          .map(
            (point) => `
    <div class="p-2 rounded-md bg-card border border-line mb-1.5 text-xs hover:border-line-highlight transition-colors">
      <div class="flex justify-between items-center">
        <strong class="font-semibold text-ink">${escapeHtml(point.phase)}</strong>
        <div class="flex items-center gap-1">
          <button class="btn btn-secondary text-[10px] px-1.5 py-0.5" data-fork="${escapeHtml(point.id)}">Fork</button>
          <button class="btn btn-danger text-[10px] px-1.5 py-0.5 opacity-60 hover:opacity-100" data-purge="${escapeHtml(point.id)}" title="Delete every savepoint recorded before this one">Purge</button>
        </div>
      </div>
      <div class="text-muted text-[10.5px] mt-0.5">${escapeHtml(point.task_name)} · ${escapeHtml(new Date(point.created_at).toLocaleTimeString())}</div>
    </div>
  `,
          )
          .join("")
      : '<small class="text-muted text-xs">No save points recorded.</small>';
  }

  document.querySelectorAll<HTMLButtonElement>("[data-fork]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const response = await fetch(`/instance/${id}/fork/${button.dataset.fork}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variables: {} }),
      });
      if (response.ok) {
        location.href = `/instance/${(await response.json()).workflow_id}`;
      }
    };
  });

  document.querySelectorAll<HTMLButtonElement>("[data-purge]").forEach((button) => {
    button.onclick = async () => {
      const anchorId = button.dataset.purge;
      if (!anchorId) return;
      const point = spList.find((p) => p.id === anchorId);
      if (!point) return;
      if (!window.confirm(describePurge(spList, anchorId))) return;

      button.disabled = true;
      try {
        const response = await fetch(`/instance/${id}/savepoints`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildPurgeRequest(point)),
        });
        if (response.ok) {
          await refresh();
        } else {
          const body = await response.json().catch(() => null);
          alert(`Purge failed: ${body?.detail || response.statusText}`);
          button.disabled = false;
        }
      } catch (e) {
        alert(`Purge failed: ${e}`);
        button.disabled = false;
      }
    };
  });

  const dataEl = $("data");
  if (dataEl) dataEl.textContent = JSON.stringify(next.data, null, 2);

  const wsMeta = next.data.workspace_metadata;
  const wsFiles = wsMeta?.files;
  if (wsFiles && wsFiles.length > 0) {
    const wsCard = $("workspace-files-card");
    if (wsCard) {
      wsCard.classList.remove("hidden");
      const wsFilesBadge = $("ws-files-badge");
      if (wsFilesBadge) wsFilesBadge.textContent = String(wsFiles.length);
      const wsFilesEl = $("ws-files");
      if (wsFilesEl) {
        wsFilesEl.innerHTML = wsFiles
          .map((f) => {
            const sizeStr = f.size > 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`;
            return `
          <div class="flex items-center justify-between p-1.5 rounded bg-card border border-line hover:border-line-highlight transition-colors">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-accent text-[11px]">📄</span>
              <span class="font-mono text-[11px] truncate text-ink" title="${escapeHtml(f.path)}">${escapeHtml(f.name || f.path)}</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-muted text-[10px]">${escapeHtml(sizeStr)}</span>
              <a href="/instance/${id}/workspace/file?path=${encodeURIComponent(f.path)}" target="_blank" class="btn btn-secondary text-[9.5px] px-1.5 py-0.5" title="View / Download file">View</a>
            </div>
          </div>`;
          })
          .join("");
      }
    }
    const wsBtn = document.querySelector<HTMLAnchorElement>("a[href*='workspace']");
    if (wsBtn) {
      const totalSize = wsMeta?.total_size || 0;
      const sizeStr = totalSize > 1024 ? `${(totalSize / 1024).toFixed(1)} KB` : `${totalSize} B`;
      wsBtn.title = `Download Workspace Archive (${wsFiles.length} files, ${sizeStr})`;
    }
  } else {
    $("workspace-files-card")?.classList.add("hidden");
  }

  reviewTask = next.tasks.find((t) => t.state === "READY" && (t.type === "UserTask" || !t.type));
  if (reviewTask) {
    $("review-card")?.classList.remove("hidden");
    void loadForm();
  } else {
    $("review-card")?.classList.add("hidden");
  }

  if (viewer) {
    const canvas = viewer.get("canvas");
    next.tasks.filter((t) => t.state === "STARTED").forEach((t) => canvas.addMarker(t.bpmn_id, "task-active"));
    next.tasks.filter((t) => t.state === "READY").forEach((t) => canvas.addMarker(t.bpmn_id, "task-ready"));
    next.tasks.filter((t) => t.state === "COMPLETED").forEach((t) => canvas.addMarker(t.bpmn_id, "task-completed"));
  }
}

async function load(): Promise<void> {
  const [xmlResponse, stateResponse] = await Promise.all([fetch(`/instance/${id}/diagram`), fetch(`/instance/${id}/state`)]);
  const xml = await xmlResponse.text();

  const ViewerCtor = window.BpmnNavigatedViewer || window.BpmnJS;
  if (!ViewerCtor) return;
  viewer = new (ViewerCtor as new (options: { container: string; additionalModules?: unknown[] }) => BpmnDiagramInstance)({
    container: "#canvas",
    additionalModules: [window.minimapModule].filter(Boolean),
  });

  await viewer.importXML(xml);
  fitDiagram(viewer);
  renderState(await stateResponse.json());
  initWebSocket();
}

wireZoomControls(() => viewer, {
  zoomIn: "ctrl-zoom-in",
  zoomOut: "ctrl-zoom-out",
  fit: "ctrl-zoom-fit",
  reset: "ctrl-zoom-reset",
  minimap: "ctrl-minimap",
});

const backoff = createBackoffScheduler(1000, 30000);
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    if (state && (state.status === "waiting_pi" || state.status === "running")) {
      backoff.grow();
      initWebSocket();
      void refresh();
    }
  }, backoff.delay);
}

function initWebSocket(): void {
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws/instance/${id}`);
    ws.onopen = () => {
      backoff.reset();
    };
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "pi_event" && payload.workflow_id === id) {
          const ev = payload.event || {};
          const statusEl = $("status");
          if (statusEl && ev.type) {
            statusEl.innerHTML = `<span class="badge badge-running mr-1.5 animate-pulse">●</span> running (${escapeHtml(payload.task_name || "Agent")}: ${escapeHtml(ev.type)})`;
          }
        } else if (payload.workflow_id === id) {
          renderState(payload);
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      scheduleReconnect();
    };
    ws.onerror = () => {
      scheduleReconnect();
    };
  } catch {
    scheduleReconnect();
  }
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch(`/instance/${id}/state`);
    if (response.ok) {
      renderState(await response.json());
    }
  } catch {
    // next reconnect/poll will retry
  }
}

async function loadForm(): Promise<void> {
  if (!reviewTask) return;
  const response = await fetch(`/instance/${id}/form/${reviewTask.id}`);
  if (!response.ok) return;
  const schema = await response.json();
  if (!formViewer) {
    const FormCtor = (window.FormJS || window.FormViewer)?.Form;
    if (!FormCtor) return;
    formViewer = new FormCtor({ container: "#fields" });
  }
  const initialData = withDocumentContentFallback(state?.data);
  await formViewer.importSchema(schema, initialData);
}

const submitBtn = $("submit");
if (submitBtn) {
  submitBtn.onclick = async () => {
    if (!formViewer || !reviewTask) return;
    const { data, errors } = formViewer._getState();
    if (Object.keys(errors).length > 0) return;
    const response = await fetch(`/instance/${id}/submit-task/${reviewTask.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variables: data }),
    });
    if (response.ok) {
      $("review-card")?.classList.add("hidden");
      renderState(await response.json());
    }
  };
}

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
