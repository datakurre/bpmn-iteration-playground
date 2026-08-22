import { $, escapeHtml, renderList } from "../lib/dom";

interface StorageStats {
  size_human: string;
  instances_count: number;
  save_points_count: number;
}

interface AdminInstance {
  workflow_id: string;
  process_id: string;
  status: string;
  task_count: number;
}

interface PackResult {
  reclaimed_human: string;
  size_after_human: string;
}

const root = $("instances");
const packBtn = $("pack") as HTMLButtonElement | null;
const clearBtn = $("clear") as HTMLButtonElement | null;

async function loadStorage(): Promise<void> {
  try {
    const res = await fetch("/api/history/storage");
    if (res.ok) {
      const data = (await res.json()) as StorageStats;
      const storageEl = $("m-storage");
      const instancesEl = $("m-instances");
      const savepointsEl = $("m-savepoints");
      if (storageEl) storageEl.textContent = data.size_human;
      if (instancesEl) instancesEl.textContent = String(data.instances_count);
      if (savepointsEl) savepointsEl.textContent = String(data.save_points_count);
    }
  } catch {
    // storage stats are best-effort
  }
}

async function load(): Promise<void> {
  loadStorage();
  if (!root) return;
  const response = await fetch("/admin/instances");
  if (!response.ok) {
    root.innerHTML = '<p class="text-muted text-xs">Could not load instances (admin auth required if configured).</p>';
    return;
  }
  const items = (await response.json()) as AdminInstance[];
  renderList(
    root,
    items,
    (item) => `
    <div class="flex justify-between gap-3.5 items-center bg-panel border border-line rounded-lg p-3 my-1.5 hover:border-line-highlight transition-colors shadow-md">
      <div>
        <strong class="block text-[13.5px] text-ink"><a href="/instance/${encodeURIComponent(item.workflow_id)}" class="text-inherit no-underline hover:text-accent transition-colors">${escapeHtml(item.workflow_id)}</a></strong>
        <small class="text-muted text-[11.5px]">${escapeHtml(item.process_id)} · ${escapeHtml(item.status)} · ${escapeHtml(item.task_count)} tasks</small>
      </div>
      <button class="btn btn-danger text-xs px-2.5 py-1" data-delete="${escapeHtml(item.workflow_id)}">Delete</button>
    </div>
  `,
    '<p class="text-muted text-xs">No persisted instances.</p>',
  );

  document.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((button) => {
    button.onclick = async () => {
      if (confirm("Delete this persisted instance?")) {
        await fetch("/admin/instances/" + button.dataset.delete, { method: "DELETE" });
        load();
      }
    };
  });
}

if (packBtn) {
  packBtn.onclick = async () => {
    packBtn.disabled = true;
    packBtn.textContent = "Packing...";
    try {
      const res = await fetch("/admin/pack", { method: "POST" });
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
      packBtn.textContent = "Pack Database (db.pack)";
    }
  };
}

if (clearBtn) {
  clearBtn.onclick = async () => {
    if (confirm("Type DELETE_ALL in the next prompt to clear the database.")) {
      const value = prompt("Confirmation");
      if (value === "DELETE_ALL") {
        await fetch("/admin/instances?confirm=DELETE_ALL", { method: "DELETE" });
        load();
      }
    }
  };
}

load();
