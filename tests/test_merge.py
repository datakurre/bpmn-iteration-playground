"""`WorkflowService.merge()` -- docs/meta-agent-refactor-plan.md §6, manual `bpmn merge`
only. Exercises real `git merge` against a real workspace checkout, not a mocked one:
merge mechanics are exactly the kind of thing that looks right until `git merge --abort`
leaves a repo in a state a mock would never catch.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Any

import pytest

from bpmn_agent.adapters.base import AgentResult, BaseAdapter
from bpmn_agent.agents_root import Workspace
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.workflow_service import MergeUnsupportedError, WorkflowService


class FileWritingAdapter(BaseAdapter):
    def __init__(self) -> None:
        self.cwds: list[str] = []

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
        self.cwds.append(cwd)
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


def _current_branch(path: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path, capture_output=True, text=True, check=True
    ).stdout.strip()


async def _wait_for_agent_turns(service: WorkflowService) -> None:
    async def _wait() -> None:
        while any(not job.done() for job in list(service.jobs.values())):
            pending = [j for j in list(service.jobs.values()) if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_wait(), timeout=5.0)


async def _run_to_completion(tmp_path: Path) -> tuple[WorkflowService, WorkflowStore, Workspace, str]:
    _init_git_repo(tmp_path)
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    store = WorkflowStore(":memory:")
    adapter = FileWritingAdapter()
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(adapter)

    started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)
    assert service.state(workflow_id)["status"] == "completed"
    return service, store, workspace, workflow_id


@pytest.mark.anyio
async def test_merge_lands_a_no_ff_commit_on_the_checked_out_branch(tmp_path: Path) -> None:
    service, store, workspace, workflow_id = await _run_to_completion(tmp_path)
    assert _current_branch(workspace.root) == "master" or _current_branch(workspace.root) == "main"
    base_branch = _current_branch(workspace.root)

    result = await service.merge(workflow_id)

    assert result["merge_state"] == "merged"
    assert result["merge_commit"]
    assert (workspace.root / "file_1.txt").is_file(), "the merge commit updated the checked-out working tree"
    assert (workspace.root / "file_2.txt").is_file()

    log = subprocess.run(
        ["git", "log", "-1", "--format=%P"], cwd=workspace.root, capture_output=True, text=True, check=True
    ).stdout.strip()
    assert len(log.split()) == 2, "a --no-ff merge always has two parents"
    assert _current_branch(workspace.root) == base_branch, "merge must not switch the checked-out branch"

    store.close()


@pytest.mark.anyio
async def test_merge_is_idempotent_to_reread_via_state(tmp_path: Path) -> None:
    service, store, _workspace, workflow_id = await _run_to_completion(tmp_path)
    await service.merge(workflow_id)

    state = service.state(workflow_id)
    assert state["merge_state"] == "merged"
    assert state["merge_commit"]
    assert state["merge_deferred_reason"] is None

    store.close()


@pytest.mark.anyio
async def test_merge_is_deferred_when_the_checked_out_branch_is_dirty(tmp_path: Path) -> None:
    service, store, workspace, workflow_id = await _run_to_completion(tmp_path)
    (workspace.root / "uncommitted.txt").write_text("dirty\n", encoding="utf-8")

    result = await service.merge(workflow_id)

    assert result["merge_state"] == "merge_deferred"
    assert "uncommitted" in result["merge_deferred_reason"]
    # The run's branch is untouched -- nothing was merged, nothing was force-resolved.
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=workspace.root, capture_output=True, text=True, check=True
    ).stdout
    assert "uncommitted.txt" in status

    store.close()


@pytest.mark.anyio
async def test_merge_is_deferred_on_a_real_conflict_and_leaves_the_repo_clean(tmp_path: Path) -> None:
    service, store, workspace, workflow_id = await _run_to_completion(tmp_path)

    # Create a conflicting change on the checked-out branch itself, in a file the run
    # also wrote to.
    (workspace.root / "file_1.txt").write_text("a conflicting change made after the run started\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=workspace.root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "conflicting change"], cwd=workspace.root, check=True)

    result = await service.merge(workflow_id)

    assert result["merge_state"] == "merge_deferred"
    assert result["merge_deferred_reason"]

    # git merge --abort must have run: no merge in progress, clean tree.
    assert not (workspace.root / ".git" / "MERGE_HEAD").exists()
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=workspace.root, capture_output=True, text=True, check=True
    ).stdout
    assert status.strip() == ""

    store.close()


@pytest.mark.anyio
async def test_merge_of_a_non_completed_workflow_raises_value_error(tmp_path: Path) -> None:
    service, store, _workspace, workflow_id = await _run_to_completion(tmp_path)
    # Force a non-completed status deterministically (a timing-based "catch it mid-turn"
    # test would be racy against how fast the fake adapter finishes) -- merge only cares
    # about the persisted status, so this is equivalent to catching a genuinely running
    # workflow without depending on dispatch timing.
    store.update(workflow_id, status="failed")

    with pytest.raises(ValueError, match="not completed"):
        await service.merge(workflow_id)

    store.close()


@pytest.mark.anyio
async def test_merge_without_a_git_workspace_raises_merge_unsupported(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    service = WorkflowService(store)  # no workspace at all -- BlobStrategy, library usage
    adapter = FileWritingAdapter()
    service.registry.register(adapter)

    started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)
    assert service.state(workflow_id)["status"] == "completed"

    with pytest.raises(MergeUnsupportedError):
        await service.merge(workflow_id)

    store.close()
