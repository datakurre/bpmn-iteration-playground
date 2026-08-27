from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from graph_agent.agents_root import Workspace
from graph_agent.cli import _resolve_template_path, main
from graph_agent.daemon import RuntimeInfo, write_runtime_file


def _fake_runtime(tmp_path: Path) -> Workspace:
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    info = RuntimeInfo(
        schema=1,
        pid=999999,
        port=8000,
        url="http://127.0.0.1:8000",
        token="test-token",
        started_at="2026-01-01T00:00:00+00:00",
    )
    write_runtime_file(ws, info)
    return ws


def test_resolve_template_path(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    ws.ensure()

    # Bundled template resolution
    resolved = _resolve_template_path(ws, "plan_and_execute")
    assert resolved is not None
    assert resolved.name == "plan_and_execute.bpmn"

    # Workspace custom template
    custom = ws.workflows_dir / "my_custom.bpmn"
    custom.write_text("<definitions />")
    resolved_custom = _resolve_template_path(ws, "my_custom")
    assert resolved_custom == custom


def test_cli_run_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _fake_runtime(tmp_path)

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"workflow_id": "test-run-123", "status": "running"}

    with (
        patch("graph_agent.cli.is_daemon_alive", return_value=True),
        patch("httpx.post", return_value=mock_resp) as mock_post,
    ):
        main(
            [
                "run",
                "plan_and_execute",
                "--var",
                "goal=write code",
                "--no-merge",
                "--workspace",
                str(tmp_path),
            ]
        )

        assert mock_post.called
        call_args = mock_post.call_args
        assert call_args[0][0] == "http://127.0.0.1:8000/workflow/start"
        assert call_args[1]["json"]["variables"] == {"goal": "write code", "merge_on_complete": False}

        out = capsys.readouterr().out
        assert "Started run test-run-123" in out
        assert "http://127.0.0.1:8000/instance/test-run-123" in out


def test_cli_ls_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _fake_runtime(tmp_path)

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = [
        {"workflow_id": "run-abc-123", "status": "running", "bpmn_path": "plan.bpmn", "task_count": 2}
    ]

    with patch("graph_agent.cli.is_daemon_alive", return_value=True), patch("httpx.get", return_value=mock_resp):
        main(["ls", "--workspace", str(tmp_path)])

        out = capsys.readouterr().out
        assert "RUN ID" in out
        assert "run-abc-" in out
        assert "running" in out


def test_cli_show_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _fake_runtime(tmp_path)

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "workflow_id": "run-abc",
        "status": "completed",
        "process_id": "PlanProcess",
        "bpmn_path": "plan.bpmn",
        "merge_status": "merged",
        "data": {"result": "success"},
        "tasks": [{"name": "Step 1", "state": "COMPLETED", "id": "task-1"}],
        "jobs": {"task-1": {"status": "success", "attempts": 1}},
    }

    with patch("graph_agent.cli.is_daemon_alive", return_value=True), patch("httpx.get", return_value=mock_resp):
        main(["show", "run-abc", "--workspace", str(tmp_path)])

        out = capsys.readouterr().out
        assert "Run:         run-abc" in out
        assert "Status:      completed" in out
        assert "Merge:       merged" in out


def test_cli_cancel_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _fake_runtime(tmp_path)

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"workflow_id": "run-abc", "status": "cancelled"}

    with patch("graph_agent.cli.is_daemon_alive", return_value=True), patch("httpx.post", return_value=mock_resp):
        main(["cancel", "run-abc", "--workspace", str(tmp_path)])

        out = capsys.readouterr().out
        assert "Cancelled run run-abc (status: cancelled)" in out


def test_cli_merge_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _fake_runtime(tmp_path)

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "workflow_id": "run-abc",
        "status": "merged",
        "message": "Merged bpmn/run/run-abc into main",
    }

    with patch("graph_agent.cli.is_daemon_alive", return_value=True), patch("httpx.post", return_value=mock_resp):
        main(["merge", "run-abc", "--workspace", str(tmp_path)])

        out = capsys.readouterr().out
        assert "Merged run run-abc: Merged bpmn/run/run-abc into main" in out


def test_cli_logs_command(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _fake_runtime(tmp_path)

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "workflow_id": "run-abc",
        "jobs": {
            "task-1": {
                "task_name": "Review Code",
                "status": "success",
                "prompt": "prompt text",
                "text": "output text",
                "stderr": "",
            }
        },
    }

    with patch("graph_agent.cli.is_daemon_alive", return_value=True), patch("httpx.get", return_value=mock_resp):
        main(["logs", "run-abc", "--workspace", str(tmp_path)])

        out = capsys.readouterr().out
        assert "Task: Review Code" in out
        assert "prompt text" in out
        assert "output text" in out


def test_cli_engine_flags_apply_to_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import os

    _fake_runtime(tmp_path)
    orig_env = dict(os.environ)

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"workflow_id": "run-flags", "status": "running"}

    try:
        with (
            patch("graph_agent.cli.is_daemon_alive", return_value=True),
            patch("httpx.post", return_value=mock_resp) as mock_post,
        ):
            main(
                [
                    "run",
                    "plan_and_execute",
                    "--model",
                    "gpt-test-model",
                    "--provider",
                    "test-provider",
                    "--timeout",
                    "120",
                    "--offline",
                    "--max-parallel-turns",
                    "8",
                    "--timer-interval",
                    "5",
                    "--savepoint-retention",
                    "3",
                    "--workspace-mode",
                    "blob",
                    "--log-level",
                    "debug",
                    "--workspace",
                    str(tmp_path),
                ]
            )

            assert os.environ.get("PI_MODEL") == "gpt-test-model"
            assert os.environ.get("PI_PROVIDER") == "test-provider"
            assert os.environ.get("PI_TIMEOUT_SECONDS") == "120"
            assert os.environ.get("PI_OFFLINE") == "1"
            assert os.environ.get("MAX_PARALLEL_TURNS") == "8"
            assert os.environ.get("TIMER_TICK_SECONDS") == "5"
            assert os.environ.get("SAVEPOINT_ATTEMPT_RETENTION") == "3"
            assert os.environ.get("WORKSPACE_MODE") == "blob"
            assert os.environ.get("LOG_LEVEL") == "DEBUG"

            # Check variables passed in start request
            call_args = mock_post.call_args
            assert call_args[1]["json"]["variables"]["workspace_mode"] == "blob"
            assert call_args[1]["json"]["variables"]["timeout"] == 120
    finally:
        os.environ.clear()
        os.environ.update(orig_env)
