from pathlib import Path

from graph_agent.agents_root import Workspace


def test_discover_falls_back_to_start_dir_when_nothing_found(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    assert ws.root == tmp_path.resolve()
    assert ws.is_git is False


def test_discover_finds_existing_agents_dir_in_parent(tmp_path: Path) -> None:
    (tmp_path / ".agents").mkdir()
    nested = tmp_path / "a" / "b"
    nested.mkdir(parents=True)

    ws = Workspace.discover(nested)

    assert ws.root == tmp_path.resolve()


def test_discover_finds_git_root_when_no_agents_dir(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    nested = tmp_path / "src"
    nested.mkdir()

    ws = Workspace.discover(nested)

    assert ws.root == tmp_path.resolve()
    assert ws.is_git is True


def test_discover_prefers_agents_dir_over_closer_git_root(tmp_path: Path) -> None:
    (tmp_path / ".agents").mkdir()
    inner_git_repo = tmp_path / "vendored"
    (inner_git_repo / ".git").mkdir(parents=True)
    nested = inner_git_repo / "src"
    nested.mkdir()

    ws = Workspace.discover(nested)

    assert ws.root == tmp_path.resolve()


def test_discover_records_is_git_alongside_existing_agents_dir(tmp_path: Path) -> None:
    (tmp_path / ".agents").mkdir()
    (tmp_path / ".git").mkdir()

    ws = Workspace.discover(tmp_path)

    assert ws.root == tmp_path.resolve()
    assert ws.is_git is True


def test_ensure_creates_layout_and_gitignore(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    ws.ensure()

    assert ws.agents_dir.is_dir()
    assert ws.state_dir.is_dir()
    assert ws.workflows_dir.is_dir()
    assert ws.logs_dir.is_dir()
    assert (ws.agents_dir / ".gitignore").is_file()
    # worktrees/ and runs/ are created on demand, not eagerly
    assert not ws.worktrees_dir.exists()
    assert not ws.runs_dir.exists()


def test_ensure_is_idempotent_and_does_not_clobber_existing_gitignore(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    custom = "# user-edited\n"
    (ws.agents_dir / ".gitignore").write_text(custom)

    ws.ensure()

    assert (ws.agents_dir / ".gitignore").read_text() == custom


def test_path_properties_are_derived_from_agents_dir(tmp_path: Path) -> None:
    ws = Workspace(root=tmp_path, is_git=False)

    assert ws.agents_dir == tmp_path / ".agents"
    assert ws.state_dir == tmp_path / ".agents" / "state"
    assert ws.workflows_dir == tmp_path / ".agents" / "workflows"
    assert ws.worktrees_dir == tmp_path / ".agents" / "worktrees"
    assert ws.runs_dir == tmp_path / ".agents" / "runs"
    assert ws.logs_dir == tmp_path / ".agents" / "logs"
    assert ws.runtime_file == tmp_path / ".agents" / "runtime.json"
    assert ws.config_file == tmp_path / ".agents" / "config.toml"


def test_create_app_default_service_uses_workspace_state_dir(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from graph_agent.api.server import create_app

    workspace = Workspace.discover(tmp_path)
    app = create_app(workspace=workspace)
    with TestClient(app) as client:
        resp = client.get("/health")
        assert resp.status_code == 200

    assert (workspace.state_dir / "Data.fs").is_file()


def test_create_app_explicit_service_ignores_workspace(tmp_path: Path) -> None:
    from graph_agent.api.server import create_app
    from graph_agent.persistence import WorkflowStore
    from graph_agent.workflow_service import WorkflowService

    workspace = Workspace.discover(tmp_path)
    service = WorkflowService(WorkflowStore(":memory:"))
    create_app(service=service, workspace=workspace)

    # An explicit service bypasses workspace-derived storage entirely.
    assert not workspace.agents_dir.exists()
