import subprocess
from pathlib import Path

import pytest

from bpmn_agent.agents_root import Workspace
from bpmn_agent.workspace_strategy import GitOperationError, WorktreeStrategy


def _init_git_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    (root / "README.md").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "initial"], cwd=root, check=True)


def _workspace(tmp_path: Path) -> Workspace:
    _init_git_repo(tmp_path)
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    return ws


def _current_branch(path: Path) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=path, capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


@pytest.mark.anyio
async def test_acquire_creates_a_real_worktree_on_its_own_branch(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    path = await strategy.acquire("run-1")

    assert path == ws.worktrees_dir / "run-1"
    assert path.is_dir()
    assert (path / "README.md").read_text(encoding="utf-8") == "hello\n"
    assert _current_branch(path) == "bpmn/run/run-1"


@pytest.mark.anyio
async def test_acquire_is_idempotent_for_the_same_run(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    first = await strategy.acquire("run-1")
    (first / "scratch.txt").write_text("keep me", encoding="utf-8")
    second = await strategy.acquire("run-1")

    assert second == first
    assert (second / "scratch.txt").read_text(encoding="utf-8") == "keep me"


@pytest.mark.anyio
async def test_acquire_isolates_two_runs_from_each_other(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    a = await strategy.acquire("run-a")
    b = await strategy.acquire("run-b")
    (a / "only-in-a.txt").write_text("a", encoding="utf-8")

    assert a != b
    assert (a / "only-in-a.txt").exists()
    assert not (b / "only-in-a.txt").exists()


@pytest.mark.anyio
async def test_snapshot_commits_written_files_and_returns_a_sha(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    path = await strategy.acquire("run-1")
    (path / "notes.md").write_text("agent output", encoding="utf-8")

    ref = await strategy.snapshot("run-1", "after_harness")

    assert ref is not None
    assert len(ref) == 40  # a full git SHA
    log = subprocess.run(
        ["git", "log", "--oneline", "-1"], cwd=path, capture_output=True, text=True, check=True
    ).stdout
    assert "after_harness" in log


@pytest.mark.anyio
async def test_snapshot_of_nonexistent_run_returns_none(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    assert await strategy.snapshot("never-acquired", "label") is None


@pytest.mark.anyio
async def test_restore_creates_a_new_worktree_at_the_snapshot_on_its_own_branch(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    source = await strategy.acquire("run-1")
    (source / "notes.md").write_text("v1", encoding="utf-8")
    ref = await strategy.snapshot("run-1", "checkpoint")
    (source / "notes.md").write_text("v2, after the checkpoint", encoding="utf-8")
    await strategy.snapshot("run-1", "later")

    forked = await strategy.restore(ref, "run-2")

    assert forked != source
    assert (forked / "notes.md").read_text(encoding="utf-8") == "v1"
    assert _current_branch(forked) == "bpmn/run/run-2"
    # The fork's own branch, independent of the source run's.
    assert _current_branch(source) == "bpmn/run/run-1"


@pytest.mark.anyio
async def test_discard_removes_the_worktree_but_keeps_the_branch(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    path = await strategy.acquire("run-1")
    await strategy.snapshot("run-1", "checkpoint")

    await strategy.discard("run-1")

    assert not path.exists()
    branches = subprocess.run(
        ["git", "branch", "--list", "bpmn/run/run-1"], cwd=tmp_path, capture_output=True, text=True, check=True
    ).stdout
    assert "bpmn/run/run-1" in branches


@pytest.mark.anyio
async def test_discard_of_never_acquired_run_is_a_no_op(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    await strategy.discard("never-existed")  # must not raise


@pytest.mark.anyio
async def test_release_does_not_touch_the_worktree(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    path = await strategy.acquire("run-1")
    (path / "in_progress.txt").write_text("not committed", encoding="utf-8")

    await strategy.release("run-1")

    assert path.is_dir()
    assert (path / "in_progress.txt").exists()


@pytest.mark.anyio
async def test_reacquiring_after_worktree_removal_reuses_the_existing_branch(tmp_path: Path) -> None:
    ws = _workspace(tmp_path)
    strategy = WorktreeStrategy(ws)

    path = await strategy.acquire("run-1")
    await strategy.snapshot("run-1", "checkpoint")
    await strategy.discard("run-1")
    assert not path.exists()

    reacquired = await strategy.acquire("run-1")

    assert reacquired == path
    assert reacquired.is_dir()
    assert _current_branch(reacquired) == "bpmn/run/run-1"


def test_git_operation_error_is_a_runtime_error() -> None:
    assert issubclass(GitOperationError, RuntimeError)
