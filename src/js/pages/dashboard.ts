import { $, escapeHtml, renderList } from "../lib/dom";
import "../lib/accordion";
import { withDocumentContentFallback } from "../lib/form-data-fallback";
import type { FormInstance } from "../types/globals";

interface TaskSummary {
  id: string;
  bpmn_id: string;
  name?: string;
  type?: string;
  state: string;
}

interface WorkflowState {
  workflow_id: string;
  parent_workflow_id?: string;
  status: string;
  tasks: TaskSummary[];
  data: Record<string, unknown>;
}

interface TemplateSummary {
  path: string;
  name: string;
  description?: string;
}

interface PendingInstanceSummary {
  workflow_id?: string;
  id?: string;
  process_id?: string;
  updated_at?: string;
  created_at?: string;
}

let current: WorkflowState | null = null;
let reviewTask: TaskSummary | undefined;
let formViewer: FormInstance | null = null;

function copyDashboardData(): void {
  if (current?.data) {
    navigator.clipboard.writeText(JSON.stringify(current.data, null, 2));
    alert("Workflow data copied to clipboard!");
  }
}

declare global {
  interface Window {
    copyDashboardData: typeof copyDashboardData;
  }
}
window.copyDashboardData = copyDashboardData;

async function health(): Promise<void> {
  const healthEl = $("health");
  if (!healthEl) return;
  try {
    await fetch("/health");
    healthEl.textContent = "API online";
  } catch {
    healthEl.textContent = "API unavailable";
  }
}

async function loadTemplates(): Promise<void> {
  try {
    const res = await fetch("/api/templates");
    if (!res.ok) return;
    const templates: TemplateSummary[] = await res.json();
    const select = $("template-select") as HTMLSelectElement | null;
    if (select && templates.length) {
      select.innerHTML = templates
        .map(
          (t) =>
            `<option value="${escapeHtml(t.path)}">${escapeHtml(t.name)} ${t.description ? "— " + escapeHtml(t.description) : ""}</option>`,
        )
        .join("");
    }
  } catch {
    // template list is optional; leave the default option in place
  }
}

function show(state: WorkflowState): void {
  current = state;
  let titleHtml = `<a href="/instance/${encodeURIComponent(state.workflow_id)}" class="text-inherit no-underline hover:text-accent transition-colors">${escapeHtml(state.workflow_id)}</a>`;
  if (state.parent_workflow_id) {
    titleHtml += ` <a href="/instance/${encodeURIComponent(state.parent_workflow_id)}" class="badge bg-[#2b3b51] text-white no-underline text-[11px] align-middle ml-1.5">⬑ Parent</a>`;
  }
  const workflowEl = $("workflow");
  if (workflowEl) workflowEl.innerHTML = titleHtml;
  const statusEl = $("status");
  if (statusEl) {
    statusEl.textContent = state.status;
    statusEl.className = `badge ${state.status}`;
  }
  const messageEl = $("message");
  if (state.status !== "waiting_pi" && messageEl) messageEl.textContent = "";
  const tasksEl = $("tasks");
  if (tasksEl) {
    tasksEl.className = "";
    tasksEl.innerHTML = state.tasks
      .map(
        (t) => `<div class="p-2.5 rounded-md bg-card border border-line mb-2 text-xs hover:border-line-highlight transition-colors">
      <div class="flex justify-between items-center gap-2">
        <div>
          <div class="font-semibold text-ink text-[12.5px]">${escapeHtml(t.name || t.bpmn_id)}</div>
          <div class="text-muted font-mono text-[10.5px] mt-0.5">${escapeHtml(t.id)} · ${escapeHtml(t.type || "Task")}</div>
        </div>
        <span class="badge ${escapeHtml(t.state.toLowerCase())}">${escapeHtml(t.state)}</span>
      </div>
    </div>`,
      )
      .join("");
  }

  $("data-card")?.classList.remove("hidden");
  const dataEl = $("data");
  if (dataEl) dataEl.textContent = JSON.stringify(state.data, null, 2);

  reviewTask = state.tasks.find((t) => t.state === "READY" && (t.type === "UserTask" || !t.type));
  if (reviewTask) {
    void loadForm();
  } else {
    $("review")?.classList.add("hidden");
  }
}

async function poll(): Promise<void> {
  if (!current) return;
  const r = await fetch(`/instance/${current.workflow_id}/state`);
  if (r.ok) show(await r.json());
  if (current.status === "waiting_pi") setTimeout(() => void poll(), 500);
}

async function loadForm(): Promise<void> {
  if (!current || !reviewTask) return;
  const r = await fetch(`/workflow/${current.workflow_id}/form/${reviewTask.id}`);
  if (!r.ok) return;
  const schema = await r.json();
  $("review")?.classList.remove("hidden");
  if (!formViewer) {
    const FormCtor = (window.FormJS || window.FormViewer)?.Form;
    if (!FormCtor) return;
    formViewer = new FormCtor({ container: "#fields" });
  }
  const initialData = withDocumentContentFallback(current.data);
  await formViewer.importSchema(schema, initialData);
}

const startBtn = $("start") as HTMLButtonElement | null;
if (startBtn) {
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    const messageEl = $("message");
    if (messageEl) messageEl.textContent = "Persisting workflow and launching process...";
    const templateSelect = $("template-select") as HTMLSelectElement | null;
    const bpmnPath = templateSelect?.value || "workflows/contract_review.bpmn";
    const inputVal = ($("contract") as HTMLTextAreaElement | null)?.value ?? "";
    let variables: unknown = { contract: inputVal };
    try {
      if (inputVal.trim().startsWith("{")) {
        variables = JSON.parse(inputVal);
      }
    } catch {
      // fall back to the raw-text `contract` variable set above
    }

    const r = await fetch("/workflow/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bpmn_path: bpmnPath, variables }),
    });
    if (r.ok) {
      const state: WorkflowState = await r.json();
      location.href = `/instance/${state.workflow_id}`;
    } else if (messageEl) {
      messageEl.textContent = await r.text();
    }
    startBtn.disabled = false;
  };
}

const submitBtn = $("submit");
if (submitBtn) {
  submitBtn.onclick = async () => {
    if (!formViewer || !reviewTask || !current) return;
    const { data, errors } = formViewer._getState();
    if (Object.keys(errors).length > 0) return;
    const r = await fetch(`/workflow/${current.workflow_id}/submit-task/${reviewTask.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variables: data }),
    });
    if (r.ok) {
      $("review")?.classList.add("hidden");
      show(await r.json());
    }
  };
}

async function loadPendingTasks(): Promise<void> {
  try {
    const res = await fetch("/api/history/instances?status=waiting_human");
    if (!res.ok) return;
    const instances: PendingInstanceSummary[] = await res.json();
    const countEl = $("pending-count");
    const listEl = $("pending-tasks-list");
    if (countEl) countEl.textContent = String(instances.length);
    if (!listEl) return;
    renderList(
      listEl,
      instances,
      (inst) => {
        const wfId = inst.workflow_id || inst.id || "";
        return `
      <div class="p-2.5 rounded-md bg-card border border-amber-border/60 hover:border-amber transition-colors flex flex-col gap-1.5 shadow-sm">
        <div class="flex justify-between items-start gap-2">
          <strong class="text-xs font-semibold text-ink truncate">${escapeHtml(inst.process_id || "Workflow")}</strong>
          <span class="badge waiting_human text-[9.5px]">Action Needed</span>
        </div>
        <div class="text-[10.5px] text-muted font-mono truncate">${escapeHtml(wfId)}</div>
        <div class="flex justify-between items-center mt-1">
          <small class="text-[10px] text-muted">${escapeHtml(new Date(inst.updated_at || inst.created_at || "").toLocaleTimeString())}</small>
          <a href="/instance/${encodeURIComponent(wfId)}" class="btn text-[11px] px-2.5 py-1 inline-flex items-center gap-1">Open &amp; Review →</a>
        </div>
      </div>`;
      },
      '<div class="text-muted text-xs py-3 text-center bg-card rounded-md border border-line-subtle">✓ No pending tasks needing action.</div>',
    );
  } catch (err) {
    console.error("Failed to load pending tasks:", err);
  }
}

let pendingTasksTimer: ReturnType<typeof setInterval> | null = null;

function startPendingTasksPolling(): void {
  if (pendingTasksTimer) clearInterval(pendingTasksTimer);
  pendingTasksTimer = setInterval(() => {
    if (!document.hidden) {
      void loadPendingTasks();
    }
  }, 5000);
}

function stopPendingTasksPolling(): void {
  if (pendingTasksTimer) {
    clearInterval(pendingTasksTimer);
    pendingTasksTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPendingTasksPolling();
  } else {
    void loadPendingTasks();
    startPendingTasksPolling();
  }
});

void health();
void loadTemplates();
void loadPendingTasks();
startPendingTasksPolling();
