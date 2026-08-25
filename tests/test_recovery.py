import asyncio
import subprocess
from pathlib import Path

from bpmn_agent.agents_root import Workspace
from bpmn_agent.engine import WorkflowRunner
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.workflow_service import WorkflowService
from bpmn_agent.workspace_strategy import WorktreeStrategy


def test_orphan_recovery_on_startup() -> None:
    async def scenario() -> None:
        store = WorkflowStore(":memory:")
        runner = WorkflowRunner()
        workflow, pid = runner.load_workflow("bpmn_agent/data/workflows/contract_review.bpmn")
        record = runner.record(
            "orphaned-wf-1",
            workflow,
            "bpmn_agent/data/workflows/contract_review.bpmn",
            pid,
            "waiting_pi",
            jobs={"task-1": {"status": "running"}},
            save_points=[],
            events=[],
        )
        store.save("orphaned-wf-1", record)

        service = WorkflowService(store)
        assert service.state("orphaned-wf-1")["status"] == "waiting_pi"

        recovered = await service.recover_orphaned_workflows()
        assert recovered == 1

        updated_state = service.state("orphaned-wf-1")
        assert updated_state["status"] == "failed"
        assert "orphaned workflow" in updated_state["failure_reason"].lower()

    asyncio.run(scenario())


def _init_git_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    (root / "README.md").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=root, check=True)


def test_recover_orphaned_workflows_reclaims_worktree_with_no_record(tmp_path: Path) -> None:
    async def scenario() -> None:
        _init_git_repo(tmp_path)
        ws = Workspace.discover(tmp_path)
        ws.ensure()
        strategy = WorktreeStrategy(ws)
        path = await strategy.acquire("orphan-run")
        assert path.is_dir()

        store = WorkflowStore(":memory:")
        service = WorkflowService(store, workspace=ws)

        recovered = await service.recover_orphaned_workflows()

        assert recovered == 0
        assert not path.exists(), "a worktree with no instance record at all must be reclaimed on startup"
        store.close()

    asyncio.run(scenario())


def test_recover_orphaned_workflows_preserves_worktree_of_known_instance(tmp_path: Path) -> None:
    async def scenario() -> None:
        _init_git_repo(tmp_path)
        ws = Workspace.discover(tmp_path)
        ws.ensure()
        strategy = WorktreeStrategy(ws)
        path = await strategy.acquire("known-run")
        assert path.is_dir()

        store = WorkflowStore(":memory:")
        runner = WorkflowRunner()
        workflow, pid = runner.load_workflow("bpmn_agent/data/workflows/contract_review.bpmn")
        record = runner.record(
            "known-run",
            workflow,
            "bpmn_agent/data/workflows/contract_review.bpmn",
            pid,
            "failed",
            jobs={},
            save_points=[],
            events=[],
        )
        store.save("known-run", record)

        service = WorkflowService(store, workspace=ws)
        recovered = await service.recover_orphaned_workflows()

        assert recovered == 0
        assert path.is_dir(), "a worktree whose instance record still exists must never be touched here"
        store.close()

    asyncio.run(scenario())
