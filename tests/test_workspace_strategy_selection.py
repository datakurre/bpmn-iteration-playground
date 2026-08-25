from pathlib import Path

import pytest

from graph_agent.agents_root import Workspace
from graph_agent.persistence import WorkflowStore
from graph_agent.workspace_strategy import BlobStrategy, InPlaceStrategy, WorktreeStrategy, select_strategy


def _git_workspace(tmp_path: Path) -> Workspace:
    (tmp_path / ".git").mkdir()
    return Workspace.discover(tmp_path)


def _non_git_workspace(tmp_path: Path) -> Workspace:
    return Workspace.discover(tmp_path)


def test_no_workspace_always_selects_blob_regardless_of_mode(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    assert isinstance(select_strategy(None, store, {}, {}), BlobStrategy)
    assert isinstance(select_strategy(None, store, {"workspace_mode": "blob"}, {}), BlobStrategy)


def test_no_workspace_and_explicit_worktree_mode_raises(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    with pytest.raises(ValueError, match="requires a workspace-backed"):
        select_strategy(None, store, {"workspace_mode": "worktree"}, {})


def test_no_workspace_and_explicit_in_place_mode_raises(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    with pytest.raises(ValueError, match="requires a workspace-backed"):
        select_strategy(None, store, {"workspace_mode": "in_place"}, {})


def test_unknown_mode_raises(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    with pytest.raises(ValueError, match="unknown workspace_mode"):
        select_strategy(None, store, {"workspace_mode": "nonsense"}, {})


def test_git_workspace_defaults_to_worktree(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    ws = _git_workspace(tmp_path)
    assert isinstance(select_strategy(ws, store, {}, {}), WorktreeStrategy)


def test_non_git_workspace_defaults_to_in_place(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    ws = _non_git_workspace(tmp_path)
    assert isinstance(select_strategy(ws, store, {}, {}), InPlaceStrategy)


def test_task_property_overrides_git_default_to_blob(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    ws = _git_workspace(tmp_path)
    assert isinstance(select_strategy(ws, store, {"workspace_mode": "blob"}, {}), BlobStrategy)


def test_task_property_overrides_git_default_to_in_place(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    ws = _git_workspace(tmp_path)
    assert isinstance(select_strategy(ws, store, {"workspace_mode": "in_place"}, {}), InPlaceStrategy)


def test_workflow_data_provides_the_fallback_when_no_task_property(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    ws = _git_workspace(tmp_path)
    result = select_strategy(ws, store, {}, {"workspace_mode": "blob"})
    assert isinstance(result, BlobStrategy)


def test_task_property_wins_over_workflow_data(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    ws = _git_workspace(tmp_path)
    result = select_strategy(ws, store, {"workspace_mode": "in_place"}, {"workspace_mode": "blob"})
    assert isinstance(result, InPlaceStrategy)
