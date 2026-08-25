import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from graph_agent.agents_root import Workspace
from graph_agent.cli import _materialize_bundled_workflows, main
from graph_agent.daemon import RuntimeInfo, read_runtime_file, write_runtime_file
from graph_agent.registry import BUNDLED_WORKFLOWS_DIR


@pytest.fixture
def _restore_admin_token_env():
    """`_cmd_serve` sets ADMIN_TOKEN as a real process-wide side effect -- correct for an
    actual `bpmn serve` process, but every test in this session shares one interpreter, so
    a test that reaches that code path would otherwise leak a real token into every test
    that runs after it (turning their normal fail-open auth into a 401/403)."""
    original = os.environ.get("ADMIN_TOKEN")
    yield
    if original is None:
        os.environ.pop("ADMIN_TOKEN", None)
    else:
        os.environ["ADMIN_TOKEN"] = original


def _fake_runtime_info(**overrides: object) -> RuntimeInfo:
    defaults: dict[str, object] = {
        "schema": 1,
        "pid": 2**30,  # never a real pid
        "port": 55555,
        "url": "http://127.0.0.1:55555",
        "token": "old-token",
        "started_at": "2026-01-01T00:00:00+00:00",
    }
    defaults.update(overrides)
    return RuntimeInfo(**defaults)  # type: ignore[arg-type]


def test_materialize_bundled_workflows_copies_every_bundled_template(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    copied, skipped = _materialize_bundled_workflows(workspace)

    bundled_names = {p.name for p in BUNDLED_WORKFLOWS_DIR.glob("*.bpmn")}
    assert copied == len(bundled_names)
    assert skipped == 0
    materialized_names = {p.name for p in workspace.workflows_dir.glob("*.bpmn")}
    assert materialized_names == bundled_names


def test_materialize_bundled_workflows_never_overwrites_existing_files(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    one_template = next(iter(BUNDLED_WORKFLOWS_DIR.glob("*.bpmn")))
    edited = workspace.workflows_dir / one_template.name
    edited.write_text("<!-- hand-edited -->", encoding="utf-8")

    copied, skipped = _materialize_bundled_workflows(workspace)

    assert skipped >= 1
    assert edited.read_text(encoding="utf-8") == "<!-- hand-edited -->"
    total_bundled = len(list(BUNDLED_WORKFLOWS_DIR.glob("*.bpmn")))
    assert copied + skipped == total_bundled


def test_cli_init_creates_agents_layout_and_prints_summary(tmp_path: Path, capsys) -> None:
    main(["init", "--workspace", str(tmp_path)])

    workspace = Workspace.discover(tmp_path)
    assert workspace.agents_dir.is_dir()
    assert workspace.state_dir.is_dir()
    assert list(workspace.workflows_dir.glob("*.bpmn"))

    out = capsys.readouterr().out
    assert "Initialized workspace" in out
    assert str(tmp_path.resolve()) in out


def test_cli_init_warns_when_not_a_git_repo(tmp_path: Path, capsys) -> None:
    main(["init", "--workspace", str(tmp_path)])

    out = capsys.readouterr().out
    assert "isn't a git repository" in out


def test_cli_init_is_quiet_about_git_when_workspace_is_a_repo(tmp_path: Path, capsys) -> None:
    (tmp_path / ".git").mkdir()

    main(["init", "--workspace", str(tmp_path)])

    out = capsys.readouterr().out
    assert "isn't a git repository" not in out


def test_cli_serve_reload_falls_back_to_uvicorn_run() -> None:
    with patch("graph_agent.cli.uvicorn.run") as mock_run:
        main(["serve", "--host", "0.0.0.0", "--port", "9001", "--reload"])
    mock_run.assert_called_once_with("graph_agent.api.server:app", host="0.0.0.0", port=9001, reload=True)


def test_cli_serve_reload_with_no_port_defaults_to_8000() -> None:
    with patch("graph_agent.cli.uvicorn.run") as mock_run:
        main(["serve", "--reload"])
    mock_run.assert_called_once_with("graph_agent.api.server:app", host="127.0.0.1", port=8000, reload=True)


def test_cli_serve_binds_free_port_writes_runtime_and_cleans_up(
    tmp_path: Path, _restore_admin_token_env: None
) -> None:
    workspace = Workspace.discover(tmp_path)
    captured: dict[str, object] = {}

    def fake_run(sockets: list[object] | None = None) -> None:
        captured["info"] = read_runtime_file(workspace)
        captured["admin_token_env"] = os.environ.get("ADMIN_TOKEN")
        captured["sockets"] = sockets

    with patch("graph_agent.cli.uvicorn.Server") as mock_server_cls:
        mock_server_cls.return_value.run.side_effect = fake_run
        main(["serve", "--workspace", str(tmp_path)])

    info = captured["info"]
    assert isinstance(info, RuntimeInfo)
    assert info.token == captured["admin_token_env"]
    assert info.pid == os.getpid()
    assert info.port > 0
    assert captured["sockets"]
    # Cleaned up once server.run() (our stand-in) returns.
    assert not workspace.runtime_file.exists()


def test_cli_serve_skips_binding_when_daemon_already_running(tmp_path: Path, capsys) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _fake_runtime_info(url="http://127.0.0.1:55555"))

    with (
        patch("graph_agent.cli.is_daemon_alive", return_value=True),
        patch("graph_agent.cli.bind_free_port") as mock_bind,
    ):
        main(["serve", "--workspace", str(tmp_path)])

    mock_bind.assert_not_called()
    assert "Already running at http://127.0.0.1:55555" in capsys.readouterr().out


def test_cli_serve_replaces_stale_runtime_file(tmp_path: Path, _restore_admin_token_env: None) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _fake_runtime_info(token="stale-token"))

    with (
        patch("graph_agent.cli.is_daemon_alive", return_value=False),
        patch("graph_agent.cli.uvicorn.Server") as mock_server_cls,
    ):
        mock_server_cls.return_value.run = MagicMock()
        main(["serve", "--workspace", str(tmp_path)])

    mock_server_cls.return_value.run.assert_called_once()


def test_cli_status_reports_no_daemon(tmp_path: Path, capsys) -> None:
    main(["status", "--workspace", str(tmp_path)])
    assert "No daemon running" in capsys.readouterr().out


def test_cli_status_reports_stale_runtime(tmp_path: Path, capsys) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _fake_runtime_info())

    with patch("graph_agent.cli.is_daemon_alive", return_value=False):
        main(["status", "--workspace", str(tmp_path)])

    assert "Stale runtime info" in capsys.readouterr().out


def test_cli_status_reports_running_url(tmp_path: Path, capsys) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _fake_runtime_info(url="http://127.0.0.1:55555"))

    with patch("graph_agent.cli.is_daemon_alive", return_value=True):
        main(["status", "--workspace", str(tmp_path)])

    assert "http://127.0.0.1:55555" in capsys.readouterr().out


def test_cli_open_launches_browser_when_running(tmp_path: Path, capsys) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _fake_runtime_info(url="http://127.0.0.1:55555"))

    with (
        patch("graph_agent.cli.is_daemon_alive", return_value=True),
        patch("graph_agent.cli.webbrowser.open") as mock_open,
    ):
        main(["open", "--workspace", str(tmp_path)])

    mock_open.assert_called_once_with("http://127.0.0.1:55555")
    assert "Opened http://127.0.0.1:55555" in capsys.readouterr().out


def test_cli_open_reports_nothing_running(tmp_path: Path, capsys) -> None:
    with patch("graph_agent.cli.webbrowser.open") as mock_open:
        main(["open", "--workspace", str(tmp_path)])
    mock_open.assert_not_called()
    assert "No daemon running" in capsys.readouterr().out


def test_cli_stop_reports_nothing_running(tmp_path: Path, capsys) -> None:
    main(["stop", "--workspace", str(tmp_path)])
    assert "No daemon running" in capsys.readouterr().out


def test_cli_stop_reports_success(tmp_path: Path, capsys) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _fake_runtime_info())

    with patch("graph_agent.cli.stop_daemon", return_value=True):
        main(["stop", "--workspace", str(tmp_path)])

    assert "Stopped the daemon" in capsys.readouterr().out


def test_cli_stop_reports_timeout(tmp_path: Path, capsys) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _fake_runtime_info())

    with patch("graph_agent.cli.stop_daemon", return_value=False):
        main(["stop", "--workspace", str(tmp_path)])

    assert "Timed out waiting" in capsys.readouterr().out


def test_cli_help_displays_graph_agent_prog(capsys) -> None:
    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])
    assert exc_info.value.code == 0
    out = capsys.readouterr().out
    assert "usage: graph-agent" in out


def test_cli_serve_prints_graph_agent_banner(tmp_path: Path, capsys, _restore_admin_token_env: None) -> None:
    with patch("graph_agent.cli.uvicorn.Server") as mock_server_cls:
        mock_server_cls.return_value.run = MagicMock()
        main(["serve", "--workspace", str(tmp_path)])
    out = capsys.readouterr().out
    assert f"graph-agent · {tmp_path.name} · http://127.0.0.1:" in out
