"""POST /instance/{workflow_id}/merge -- the thin API layer over WorkflowService.merge()
(the git mechanics themselves are covered end-to-end in test_merge.py). This file only
proves the route wires status codes correctly.

Uses httpx.ASGITransport rather than Starlette's TestClient: TestClient runs the app on
its own event-loop thread, and a request that fires a background job (as `/workflow/start`
does here) can outlive that thread -- see pyproject.toml's `timeout` comment for the
resulting hang this project has hit before. ASGITransport runs the app on the *same* loop
as the test, so waiting for a background job to finish is a plain `await`, not a race
between two loops.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest

from bpmn_agent.adapters.base import AgentResult, BaseAdapter
from bpmn_agent.agents_root import Workspace
from bpmn_agent.api.server import create_app
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.workflow_service import WorkflowService


class _FakePi:
    async def run(self, prompt: str, cwd: str) -> PiResult:
        return PiResult(
            "success",
            {"status": "success", "summary": "ok", "findings": [], "artifacts": [], "next_action": "continue"},
            "ok",
            [],
            "",
            0,
        )


async def _wait_for_agent_turns(service: WorkflowService) -> None:
    async def _wait() -> None:
        while any(not job.done() for job in list(service.jobs.values())):
            pending = [j for j in list(service.jobs.values()) if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_wait(), timeout=5.0)


@pytest.mark.anyio
async def test_merge_of_unknown_workflow_is_404() -> None:
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, _FakePi())
    app = create_app(service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/instance/does-not-exist/merge")
    assert resp.status_code == 404
    store.close()


@pytest.mark.anyio
async def test_merge_of_a_non_completed_workflow_is_400() -> None:
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, _FakePi())
    app = create_app(service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        start_resp = await client.post(
            "/workflow/start",
            json={"bpmn_path": "bpmn_agent/data/workflows/contract_review.bpmn", "variables": {"contract": "Merge Test"}},
        )
        wf_id = start_resp.json()["workflow_id"]
        assert start_resp.json()["status"] != "completed", "contract_review.bpmn waits on a human task"

        resp = await client.post(f"/instance/{wf_id}/merge")
    assert resp.status_code == 400
    store.close()


@pytest.mark.anyio
async def test_merge_without_a_workspace_is_409() -> None:
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, _FakePi())  # no Workspace -- BlobStrategy only
    app = create_app(service)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        start_resp = await client.post(
            "/workflow/start", json={"bpmn_path": "tests/fixtures/sequential_agents.bpmn", "process_id": "sequential_agents"}
        )
        wf_id = start_resp.json()["workflow_id"]
        await _wait_for_agent_turns(service)
        assert service.state(wf_id)["status"] == "completed"

        resp = await client.post(f"/instance/{wf_id}/merge")
    assert resp.status_code == 409
    assert "workspace" in resp.json()["detail"].lower()
    store.close()


class _FileWritingAdapter(BaseAdapter):
    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
        Path(cwd, config.get("output_file", "output.txt")).write_text("written by the agent turn")
        return AgentResult(
            "success",
            {"status": "success", "summary": "ok", "findings": [], "artifacts": [], "next_action": "continue"},
            "ok",
        )


def _init_git_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    (root / "README.md").write_text("project root\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=root, check=True)


@pytest.mark.anyio
async def test_merge_of_a_completed_worktree_run_is_200_and_merges(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(_FileWritingAdapter())
    app = create_app(service)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        start_resp = await client.post(
            "/workflow/start", json={"bpmn_path": "tests/fixtures/sequential_agents.bpmn", "process_id": "sequential_agents"}
        )
        wf_id = start_resp.json()["workflow_id"]
        await _wait_for_agent_turns(service)
        assert service.state(wf_id)["status"] == "completed"

        resp = await client.post(f"/instance/{wf_id}/merge")
    assert resp.status_code == 200
    body = resp.json()
    assert body["merge_state"] == "merged"
    assert body["merge_commit"]

    store.close()
