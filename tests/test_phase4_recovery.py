import subprocess
from pathlib import Path

import pytest

from graph_agent.agents_root import Workspace
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


@pytest.mark.anyio
async def test_recover_orphaned_workflows_and_prune_worktrees(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    store = WorkflowStore(ws.state_dir)

    # Create dummy dead run record in waiting_pi
    dead_record = {
        "workflow_id": "dead-run-1",
        "status": "waiting_pi",
        "process_id": "Process_1",
        "bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn",
        "data": {},
        "tasks": [],
        "jobs": {
            "task-1": {
                "status": "running",
                "task_name": "Do Step",
                "attempts": 1,
            }
        },
    }
    store.save("dead-run-1", dead_record)

    # Create a real worktree for this dead run
    strategy = WorktreeStrategy(ws)
    await strategy.acquire("dead-run-1")
    assert (ws.worktrees_dir / "dead-run-1").is_dir()

    # Create a dangling worktree with no store record
    await strategy.acquire("dangling-run-2")
    assert (ws.worktrees_dir / "dangling-run-2").is_dir()

    service = WorkflowService(store=store, workspace=ws)
    recovered = await service.recover_orphaned_workflows()

    assert recovered == 1
    rec = store.load("dead-run-1")
    assert rec is not None
    assert rec["status"] == "failed"
    assert rec["jobs"]["task-1"]["status"] == "failed"

    # Both worktrees should be pruned
    assert not (ws.worktrees_dir / "dead-run-1").exists()
    assert not (ws.worktrees_dir / "dangling-run-2").exists()

    await service.shutdown()
