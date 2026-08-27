"""Async client for the TUI to communicate with the local graph-agent daemon."""

from __future__ import annotations

import logging
from typing import Any, cast

import httpx

from graph_agent.agents_root import Workspace
from graph_agent.daemon import is_daemon_alive, read_runtime_file

logger = logging.getLogger("graph_agent.tui.client")


class DaemonNotRunningError(Exception):
    """Raised when attempting to connect to a daemon that is not running."""


class DaemonClient:
    """HTTP client communicating with the local graph-agent daemon."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        workspace: Workspace | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.workspace = workspace
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
            headers["X-Admin-Token"] = token
        self._client = http_client or httpx.AsyncClient(base_url=self.base_url, headers=headers, timeout=30.0)

    @classmethod
    def from_workspace(cls, workspace: Workspace | None = None) -> DaemonClient:
        ws = workspace or Workspace.discover()
        runtime = read_runtime_file(ws)
        if not runtime or not is_daemon_alive(runtime):
            raise DaemonNotRunningError(f"No running daemon found for workspace at {ws.root}")
        return cls(base_url=runtime.url, token=runtime.token, workspace=ws)

    async def health(self) -> dict[str, Any]:
        resp = await self._client.get("/health")
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def list_runs(self) -> list[dict[str, Any]]:
        resp = await self._client.get("/api/history/instances")
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            return cast(list[dict[str, Any]], data)
        return cast(list[dict[str, Any]], data.get("instances", []))

    async def get_run(self, workflow_id: str) -> dict[str, Any]:
        resp = await self._client.get(f"/instance/{workflow_id}/state")
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def get_templates(self) -> list[dict[str, Any]]:
        resp = await self._client.get("/api/templates")
        resp.raise_for_status()
        return cast(list[dict[str, Any]], resp.json())

    async def get_inbox(self) -> list[dict[str, Any]]:
        """Aggregate actionable items across all graphs: pending human tasks & deferred merges."""
        runs = await self.list_runs()
        inbox_items: list[dict[str, Any]] = []

        for run in runs:
            wid = run.get("workflow_id") or run.get("id", "")
            status = run.get("status", "")
            merge_status = run.get("merge_status")

            if status == "waiting_human":
                # Find ready human tasks
                tasks = run.get("tasks", [])
                if not tasks:
                    try:
                        full_run = await self.get_run(wid)
                        tasks = full_run.get("tasks", [])
                    except Exception:
                        tasks = []
                found_task = False
                for task in tasks:
                    if task.get("state") == "READY" and task.get("type", "").lower() in ("usertask", "user_task", ""):
                        inbox_items.append(
                            {
                                "type": "human_task",
                                "workflow_id": wid,
                                "process_id": run.get("process_id", "workflow"),
                                "task_id": task.get("id"),
                                "task_name": task.get("name", "Human Task"),
                                "created_at": run.get("created_at", ""),
                                "status": status,
                            }
                        )
                        found_task = True
                if not found_task:
                    inbox_items.append(
                        {
                            "type": "human_task",
                            "workflow_id": wid,
                            "process_id": run.get("process_id", "workflow"),
                            "task_id": None,
                            "task_name": "Pending Human Input",
                            "created_at": run.get("created_at", ""),
                            "status": status,
                        }
                    )

            if merge_status == "merge_deferred":
                inbox_items.append(
                    {
                        "type": "deferred_merge",
                        "workflow_id": wid,
                        "process_id": run.get("process_id", "workflow"),
                        "task_id": None,
                        "task_name": "Auto-merge deferred (click to merge)",
                        "created_at": run.get("updated_at") or run.get("created_at", ""),
                        "merge_error": run.get("merge_error", "Working tree dirty or merge conflict"),
                        "status": "merge_deferred",
                    }
                )

        return inbox_items

    async def get_form(self, workflow_id: str, task_id: str) -> dict[str, Any]:
        resp = await self._client.get(f"/instance/{workflow_id}/form/{task_id}")
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def submit_task(self, workflow_id: str, task_id: str, data: dict[str, Any]) -> dict[str, Any]:
        resp = await self._client.post(f"/instance/{workflow_id}/submit-task/{task_id}", json={"variables": data})
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def start_run(self, bpmn_path: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = await self._client.post("/workflow/start", json={"bpmn_path": bpmn_path, "variables": variables or {}})
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def cancel_run(self, workflow_id: str) -> dict[str, Any]:
        resp = await self._client.post(f"/instance/{workflow_id}/cancel")
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def retry_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:
        resp = await self._client.post(f"/instance/{workflow_id}/retry/{task_id}")
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def merge_run(self, workflow_id: str) -> dict[str, Any]:
        resp = await self._client.post(f"/instance/{workflow_id}/merge")
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    async def get_diff(self, workflow_id: str) -> dict[str, Any]:
        resp = await self._client.get(f"/instance/{workflow_id}/diff")
        resp.raise_for_status()
        return cast(dict[str, Any], resp.json())

    def tail_logs(self, max_lines: int = 150) -> str:
        """Read recent daemon logs from disk."""
        if not self.workspace:
            return "No workspace attached."
        log_candidates = [
            self.workspace.logs_dir / "graph-agent.log",
            self.workspace.logs_dir / "daemon.log",
            self.workspace.root / "watch.log",
            self.workspace.root / "app.log",
        ]
        for candidate in log_candidates:
            if candidate.is_file():
                try:
                    lines = candidate.read_text(encoding="utf-8", errors="replace").splitlines()
                    return "\n".join(lines[-max_lines:])
                except Exception as exc:
                    return f"Error reading log file {candidate}: {exc}"
        return "No log files found in workspace."

    async def close(self) -> None:
        await self._client.aclose()
