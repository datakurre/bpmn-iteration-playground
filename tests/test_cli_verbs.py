"""CLI verbs (run/ls/show/cancel/logs) against a real FastAPI app via a monkeypatched
DaemonClient.for_workspace. The wire behavior itself (headers, status codes, SSE framing)
is already covered by test_client.py; this file covers argument parsing, output
formatting, and error handling for each verb as `main()` dispatches them.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

import bpmn_agent.cli as cli_module
from bpmn_agent.api.server import create_app
from bpmn_agent.cli import _parse_variables, main
from bpmn_agent.client import DaemonClient, DaemonNotRunningError
from bpmn_agent.daemon import RUNTIME_SCHEMA_VERSION, RuntimeInfo
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.workflow_service import WorkflowService

TOKEN = "cli-test-token"
BPMN_PATH = str(Path(__file__).parent / "fixtures" / "sequential_agents.bpmn")


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


def test_parse_variables_coerces_json_and_falls_back_to_string() -> None:
    variables = _parse_variables(["count=3", "enabled=true", "name=Alice", "obj={\"a\": 1}"])
    assert variables == {"count": 3, "enabled": True, "name": "Alice", "obj": {"a": 1}}


def test_parse_variables_rejects_a_pair_without_equals() -> None:
    with pytest.raises(SystemExit):
        _parse_variables(["not-a-pair"])


@pytest.fixture
def cli_daemon(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ADMIN_TOKEN", TOKEN)
    monkeypatch.chdir(tmp_path)
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, _FakePi())
    app = create_app(service)
    transport = httpx.ASGITransport(app=app)
    info = RuntimeInfo(
        schema=RUNTIME_SCHEMA_VERSION,
        pid=0,
        port=0,
        url="http://daemon.invalid",
        token=TOKEN,
        started_at="2026-01-01T00:00:00+00:00",
    )

    def fake_for_workspace(workspace: object, timeout: float = 30.0) -> DaemonClient:
        return DaemonClient(info, transport=transport)

    monkeypatch.setattr(cli_module.DaemonClient, "for_workspace", staticmethod(fake_for_workspace))
    yield service
    store.close()


def test_cmd_run_prints_the_new_workflow_id_and_status(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    main(["run", BPMN_PATH, "--process-id", "sequential_agents"])
    out = capsys.readouterr().out
    assert out.startswith("Started ")
    assert "(" in out and ")" in out


def test_cmd_ls_lists_a_started_instance(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    service = cli_daemon
    main(["run", BPMN_PATH, "--process-id", "sequential_agents"])
    workflow_id = capsys.readouterr().out.split()[1]

    main(["ls"])
    out = capsys.readouterr().out
    assert workflow_id in out
    assert "STATUS" in out
    assert service.instances()


def test_cmd_ls_with_no_instances_prints_a_plain_message(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    main(["ls"])
    assert capsys.readouterr().out.strip() == "No instances."


def test_cmd_show_prints_a_human_summary_by_default(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    main(["run", BPMN_PATH, "--process-id", "sequential_agents"])
    workflow_id = capsys.readouterr().out.split()[1]

    main(["show", workflow_id])
    out = capsys.readouterr().out
    assert workflow_id in out
    assert "sequential_agents" in out


def test_cmd_show_json_prints_parseable_json(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    main(["run", BPMN_PATH, "--process-id", "sequential_agents"])
    workflow_id = capsys.readouterr().out.split()[1]

    main(["show", workflow_id, "--json"])
    parsed = json.loads(capsys.readouterr().out)
    assert parsed["workflow_id"] == workflow_id


def test_cmd_show_of_unknown_workflow_exits_with_error(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["show", "does-not-exist"])
    assert "Error" in str(excinfo.value)


def test_cmd_cancel_transitions_a_running_instance(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    main(["run", BPMN_PATH, "--process-id", "sequential_agents"])
    workflow_id = capsys.readouterr().out.split()[1]

    main(["cancel", workflow_id])
    out = capsys.readouterr().out
    assert workflow_id in out
    assert "cancelled" in out


def test_cmd_logs_prints_the_event_log(cli_daemon, capsys: pytest.CaptureFixture[str]) -> None:
    main(["run", BPMN_PATH, "--process-id", "sequential_agents"])
    workflow_id = capsys.readouterr().out.split()[1]

    main(["logs", workflow_id])
    out = capsys.readouterr().out
    assert "workflow_started" in out


class _FakeStreamClient:
    """A minimal DaemonClient stand-in for `--follow`, so the test controls exactly what
    the SSE stream yields instead of waiting on the real endpoint's up-to-30s polling loop
    (see instance.py's sse_events_stream) for a workflow to reach a terminal status."""

    def __init__(self, states: list[dict]) -> None:
        self._states = states

    async def __aenter__(self) -> _FakeStreamClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    async def stream_events(self, workflow_id: str):
        for state in self._states:
            yield state


def test_cmd_logs_follow_prints_only_newly_appended_events(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    e1 = {"event_type": "workflow_started", "timestamp": "t1", "task_id": None, "task_name": None, "data": {}}
    e2 = {"event_type": "task_completed", "timestamp": "t2", "task_id": "t-1", "task_name": "Step 1", "data": {}}
    states = [
        {"workflow_id": "wf1", "events": [e1]},
        {"workflow_id": "wf1", "events": [e1]},  # unchanged -- must not be printed twice
        {"workflow_id": "wf1", "events": [e1, e2]},
    ]
    monkeypatch.setattr(
        cli_module.DaemonClient, "for_workspace", staticmethod(lambda workspace, timeout=30.0: _FakeStreamClient(states))
    )

    main(["logs", "wf1", "--follow"])

    out = capsys.readouterr().out
    assert out.count("workflow_started") == 1
    assert out.count("task_completed") == 1


def test_cmd_merge_prints_the_merged_commit(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    class _FakeMergeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info: object) -> None:
            return None

        async def merge(self, workflow_id: str) -> dict:
            return {"workflow_id": workflow_id, "merge_state": "merged", "merge_commit": "abc123"}

    monkeypatch.setattr(
        cli_module.DaemonClient, "for_workspace", staticmethod(lambda workspace, timeout=30.0: _FakeMergeClient())
    )

    main(["merge", "wf1"])

    out = capsys.readouterr().out
    assert "Merged wf1 -> abc123" in out


def test_cmd_merge_prints_the_deferred_reason(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    class _FakeMergeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info: object) -> None:
            return None

        async def merge(self, workflow_id: str) -> dict:
            return {"workflow_id": workflow_id, "merge_state": "merge_deferred", "merge_deferred_reason": "dirty tree"}

    monkeypatch.setattr(
        cli_module.DaemonClient, "for_workspace", staticmethod(lambda workspace, timeout=30.0: _FakeMergeClient())
    )

    main(["merge", "wf1"])

    out = capsys.readouterr().out
    assert "Merge deferred: dirty tree" in out


def test_no_running_daemon_exits_with_a_plain_message(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as excinfo:
        main(["ls"])
    assert isinstance(excinfo.value.__cause__, DaemonNotRunningError)
    assert "bpmn serve" in str(excinfo.value)
