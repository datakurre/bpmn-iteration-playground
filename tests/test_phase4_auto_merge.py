import asyncio
import subprocess
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from graph_agent.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter
from graph_agent.adapters.registry import AdapterRegistry
from graph_agent.agents_root import Workspace
from graph_agent.api.server import create_app
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService
from graph_agent.workspace_strategy import WorktreeStrategy


def _init_git_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=root, check=True)
    (root / "README.md").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-q", "-m", "initial"],
        cwd=root,
        check=True,
    )


class FileWritingAdapter(BaseAdapter):
    def __init__(self, filename: str = "output.txt", content: str = "from agent") -> None:
        self.filename = filename
        self.content = content

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    @property
    def capabilities(self) -> AdapterCapabilities:
        return AdapterCapabilities(display_name="File Writer", supports_sessions=False)

    async def run(
        self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None
    ) -> AgentResult:
        (Path(cwd) / self.filename).write_text(self.content, encoding="utf-8")
        return AgentResult(
            status="success",
            output={
                "status": "success",
                "summary": "wrote file",
                "findings": [],
                "artifacts": [self.filename],
                "next_action": "none",
            },
            text="wrote file",
            messages=[],
            stderr="",
            exit_code=0,
        )


async def _advance_workflow_to_completion(service: WorkflowService, workflow_id: str) -> dict[str, Any]:
    for _ in range(100):
        st = service.state(workflow_id)
        if st["status"] in ("completed", "failed", "cancelled"):
            return st
        if st["status"] == "waiting_human":
            for task in st.get("tasks", []):
                if task.get("state") == "READY":
                    tid = task["id"]
                    tname = task.get("name", "")
                    if "Review" in tname:
                        await service.submit_task(workflow_id, tid, {"plan_approval": "approved"})
                    else:
                        await service.submit_task(workflow_id, tid, {"verification_decision": "approved"})
                    break
        await asyncio.sleep(0.05)
    return service.state(workflow_id)


@pytest.mark.anyio
async def test_worktree_strategy_clean_merge(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    strategy = WorktreeStrategy(ws)

    # Acquire and write in run worktree
    run_dir = await strategy.acquire("run-1")
    (run_dir / "feature.txt").write_text("new feature\n", encoding="utf-8")
    await strategy.snapshot("run-1", "feature commit")

    # Merge into main
    success, msg = await strategy.merge("run-1", commit_message="Merge feature from run-1")
    assert success is True
    assert "Merged bpmn/run/run-1 into main" in msg

    # Verify merged file exists in main repo
    assert (tmp_path / "feature.txt").read_text(encoding="utf-8") == "new feature\n"
    # Worktree directory was cleaned up
    assert not (ws.worktrees_dir / "run-1").exists()


@pytest.mark.anyio
async def test_worktree_strategy_merge_deferred_on_dirty_working_tree(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    strategy = WorktreeStrategy(ws)

    run_dir = await strategy.acquire("run-2")
    (run_dir / "feature2.txt").write_text("feature 2\n", encoding="utf-8")
    await strategy.snapshot("run-2", "feature 2 commit")

    # Dirty the main working tree
    (tmp_path / "uncommitted.txt").write_text("dirty\n", encoding="utf-8")

    success, msg = await strategy.merge("run-2")
    assert success is False
    assert "dirty" in msg.lower()

    # Clean the working tree, now merge should succeed
    (tmp_path / "uncommitted.txt").unlink()
    success, msg = await strategy.merge("run-2")
    assert success is True


@pytest.mark.anyio
async def test_workflow_auto_merge_on_completion(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    store = WorkflowStore(ws.state_dir)
    adapter = FileWritingAdapter("result.md", "# Result from Workflow")
    registry = AdapterRegistry()
    registry.register(adapter)
    registry.bind("pi_agent", adapter)

    service = WorkflowService(store=store, adapter_registry=registry, workspace=ws)

    bpmn_path = "graph_agent/data/workflows/plan_and_execute.bpmn"
    state = await service.start(bpmn_path, variables={"goal": "test auto merge"})
    workflow_id = state["workflow_id"]

    final_state = await _advance_workflow_to_completion(service, workflow_id)

    assert final_state["status"] == "completed"
    assert final_state["merge_status"] == "merged"
    assert (tmp_path / "result.md").exists()
    await service.shutdown()


@pytest.mark.anyio
async def test_workflow_no_merge_flag_skips_auto_merge(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    store = WorkflowStore(ws.state_dir)
    adapter = FileWritingAdapter("no_merge.md", "content")
    registry = AdapterRegistry()
    registry.register(adapter)
    registry.bind("pi_agent", adapter)

    service = WorkflowService(store=store, adapter_registry=registry, workspace=ws)

    bpmn_path = "graph_agent/data/workflows/plan_and_execute.bpmn"
    state = await service.start(bpmn_path, variables={"goal": "skip merge", "merge_on_complete": False})
    workflow_id = state["workflow_id"]

    final_state = await _advance_workflow_to_completion(service, workflow_id)

    assert final_state["status"] == "completed"
    assert final_state.get("merge_status") is None
    assert not (tmp_path / "no_merge.md").exists()

    # Manual merge via service method
    merge_res = await service.merge_run(workflow_id)
    assert merge_res["status"] == "merged"
    assert (tmp_path / "no_merge.md").exists()
    await service.shutdown()


@pytest.mark.anyio
async def test_merge_api_endpoint(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    store = WorkflowStore(ws.state_dir)
    adapter = FileWritingAdapter("api_test.txt", "hello api")
    registry = AdapterRegistry()
    registry.register(adapter)
    registry.bind("pi_agent", adapter)

    service = WorkflowService(store=store, adapter_registry=registry, workspace=ws)
    bpmn_path = "graph_agent/data/workflows/plan_and_execute.bpmn"
    state = await service.start(bpmn_path, variables={"goal": "test api merge", "merge_on_complete": False})
    workflow_id = state["workflow_id"]

    await _advance_workflow_to_completion(service, workflow_id)

    app = create_app(service)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(f"/instance/{workflow_id}/merge")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "merged"
        assert data["workflow_id"] == workflow_id

    await service.shutdown()
