import { $, escapeHtml, renderList } from "../lib/dom";

interface StorageStats {
  size_human: string;
}

interface HistoryInstance {
  workflow_id: string;
  process_id: string;
  status: string;
  task_count: number;
  save_point_count: number;
  parent_workflow_id?: string | null;
  updated_at?: string | null;
}

interface PackResult {
  reclaimed_human: string;
  size_after_human: string;
}

let currentFilter = "all";
let instances: HistoryInstance[] = [];

const packBtn = $("pack-db") as HTMLButtonElement | null;
const clearBtn = $("clear-all") as HTMLButtonElement | null;

async function loadStorage(): Promise<void> {
  try {
    const res = await fetch("/api/history/storage");
    if (res.ok) {
      const data = (await res.json()) as StorageStats;
      const storageEl = $("m-storage");
      if (storageEl) storageEl.textContent = data.size_human;
    }
  } catch {
    // storage stats are best-effort
  }
}

async function loadHistory(): Promise<void> {
  loadStorage();
  const res = await fetch("/api/history/instances");
  if (res.ok) {
    instances = (await res.json()) as HistoryInstance[];
    render();
  }
}

async function deleteHistory(id: string): Promise<void> {
  if (confirm("Delete this historical instance?")) {
    const res = await fetch("/api/history/instances/" + encodeURIComponent(id), { method: "DELETE" });
    if (res.ok) loadHistory();
  }
}

if (packBtn) {
  packBtn.onclick = async () => {
    packBtn.disabled = true;
    packBtn.textContent = "Packing...";
    try {
      const res = await fetch("/api/history/pack", { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as PackResult;
        const statusEl = $("pack-status");
        if (statusEl) {
          statusEl.classList.remove("hidden");
          statusEl.textContent = `Compacted ZODB storage: reclaimed ${data.reclaimed_human} (current size: ${data.size_after_human})`;
        }
        loadStorage();
      }
    } finally {
      packBtn.disabled = false;
      packBtn.textContent = "Pack Database";
    }
  };
}

const purgeBtn = $("purge-terminal") as HTMLButtonElement | null;
if (purgeBtn) {
  purgeBtn.onclick = async () => {
    if (confirm("Purge all completed and cancelled workflow instances from ZODB?")) {
      purgeBtn.disabled = true;
      try {
        const res = await fetch("/api/history/purge?status=completed,cancelled", { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          const statusEl = $("pack-status");
          if (statusEl) {
            statusEl.classList.remove("hidden");
            statusEl.textContent = `Purged ${data.purged} completed/cancelled workflow instances.`;
          }
          loadHistory();
        }
      } finally {
        purgeBtn.disabled = false;
      }
    }
  };
}

if (clearBtn) {
  clearBtn.onclick = async () => {
    if (confirm("Delete all historical workflow instances?")) {
      const res = await fetch("/api/history/instances?confirm=DELETE_ALL", { method: "DELETE" });
      if (res.ok) loadHistory();
    }
  };
}

function render(): void {
  const filtered = instances.filter((item) => currentFilter === "all" || item.status === currentFilter);
  const totalEl = $("m-total");
  const completedEl = $("m-completed");
  const savepointsEl = $("m-savepoints");
  if (totalEl) totalEl.textContent = String(instances.length);
  if (completedEl) completedEl.textContent = String(instances.filter((i) => i.status === "completed").length);
  if (savepointsEl) savepointsEl.textContent = String(instances.reduce((acc, i) => acc + (i.save_point_count || 0), 0));

  const container = $("list");
  if (!container) return;
  renderList(
    container,
    filtered,
    (item) => `
    <article class="bg-panel border border-line rounded-lg p-3.5 mb-2 flex flex-col md:flex-row justify-between md:items-center gap-3 hover:border-line-highlight transition-colors shadow-md ${item.parent_workflow_id ? "ml-5 border-l-4 !border-l-accent" : ""}">
      <div>
        <div class="text-sm font-semibold text-ink">
          <a href="/history/${encodeURIComponent(item.workflow_id)}" class="text-inherit no-underline hover:text-accent transition-colors">${escapeHtml(item.workflow_id)}</a>
          ${item.parent_workflow_id ? '<span class="badge bg-[#2b3b51] ml-2">Subprocess</span>' : ""}
        </div>
        <div class="text-muted text-xs mt-1 flex gap-3 flex-wrap">
          <span>Process: <strong class="text-ink">${escapeHtml(item.process_id)}</strong></span>
          ${item.parent_workflow_id ? `<span>Parent: <a href="/history/${encodeURIComponent(item.parent_workflow_id)}" class="text-accent hover:underline">${escapeHtml(item.parent_workflow_id.slice(0, 8))}</a></span>` : ""}
          <span>Tasks: <strong class="text-ink">${escapeHtml(item.task_count)}</strong></span>
          <span>Save Points: <strong class="text-ink">${escapeHtml(item.save_point_count)}</strong></span>
          ${item.updated_at ? `<span>Updated: ${escapeHtml(new Date(item.updated_at).toLocaleString())}</span>` : ""}
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="badge ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
        <div class="flex items-center gap-1.5">
          <a href="/history/${encodeURIComponent(item.workflow_id)}" class="btn btn-secondary text-xs px-2.5 py-1">Inspect</a>
          <a href="/instance/${encodeURIComponent(item.workflow_id)}" class="btn text-xs px-2.5 py-1">View</a>
          <button class="btn btn-danger text-xs px-2.5 py-1" onclick="deleteHistory('${escapeHtml(item.workflow_id)}')">Delete</button>
        </div>
      </div>
    </article>
  `,
    '<div class="text-muted text-center py-8 text-xs">No process instances match the selected filter.</div>',
  );
}

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.remove("active", "text-accent", "bg-accent-dim", "border-accent-border");
      t.classList.add("text-muted", "border-line");
    });
    tab.classList.add("active", "text-accent", "bg-accent-dim", "border-accent-border");
    tab.classList.remove("text-muted", "border-line");
    currentFilter = tab.dataset.filter ?? "all";
    render();
  };
});

declare global {
  interface Window {
    deleteHistory: typeof deleteHistory;
  }
}
window.deleteHistory = deleteHistory;

loadHistory();
