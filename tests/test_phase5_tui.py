"""Unit tests for Phase 5: Textual TUI and DaemonClient."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from graph_agent.agents_root import Workspace
from graph_agent.api.server import create_app
from graph_agent.cli import main
from graph_agent.persistence import WorkflowStore
from graph_agent.tui.app import GraphAgentApp
from graph_agent.tui.client import DaemonClient, DaemonNotRunningError
from graph_agent.tui.forms import FormSchema
from graph_agent.tui.screens.detail import RunDetailScreen
from graph_agent.tui.screens.form import FormScreen
from graph_agent.tui.screens.inbox import InboxScreen
from graph_agent.tui.screens.log import LogScreen
from graph_agent.tui.screens.runs import RunsScreen
from graph_agent.tui.screens.start import StartScreen
from graph_agent.workflow_service import WorkflowService


@pytest.fixture
def mock_daemon(tmp_path: Path) -> tuple[Workspace, WorkflowService, Any]:
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    store = WorkflowStore(":memory:")
    service = WorkflowService(store=store, workspace=ws)
    app = create_app(service, workspace=ws)
    return ws, service, app


@pytest.mark.anyio
async def test_daemon_client_from_workspace_not_running(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    with pytest.raises(DaemonNotRunningError):
        DaemonClient.from_workspace(ws)


@pytest.mark.anyio
async def test_daemon_client_endpoints(mock_daemon: tuple[Workspace, WorkflowService, Any]) -> None:
    ws, _service, app = mock_daemon
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        client = DaemonClient(base_url="http://test", token="test-token", workspace=ws, http_client=http_client)

        # Health
        health = await client.health()
        assert health["status"] == "ok"

        # Templates
        templates = await client.get_templates()
        assert isinstance(templates, list)
        assert len(templates) > 0

        # Start workflow
        started = await client.start_run(
            "graph_agent/data/workflows/plan_and_execute.bpmn",
            variables={"goal": "test tui"},
        )
        wid = started["workflow_id"]
        assert wid is not None

        # List runs
        runs = await client.list_runs()
        assert any((r.get("workflow_id") or r.get("id")) == wid for r in runs)

        # Get run detail
        detail = await client.get_run(wid)
        assert detail["status"] in ("running", "waiting_pi", "waiting_human", "completed")

        # Cancel run
        cancelled = await client.cancel_run(wid)
        assert cancelled["status"] == "cancelled"

        # Close client
        await client.close()


@pytest.mark.anyio
async def test_daemon_client_inbox_aggregation(mock_daemon: tuple[Workspace, WorkflowService, Any]) -> None:
    ws, service, app = mock_daemon

    # Seed an instance waiting for human task
    service.store.save(
        "run-human",
        {
            "workflow_id": "run-human",
            "status": "waiting_human",
            "process_id": "plan_and_execute",
            "bpmn_path": "plan_and_execute.bpmn",
            "created_at": "2026-08-25T10:00:00Z",
            "tasks": [
                {
                    "id": "task-user-1",
                    "name": "Review Plan",
                    "type": "UserTask",
                    "state": "READY",
                }
            ],
        },
    )

    # Seed an instance with deferred merge
    service.store.save(
        "run-deferred-merge",
        {
            "workflow_id": "run-deferred-merge",
            "status": "completed",
            "merge_status": "merge_deferred",
            "merge_error": "Working tree is dirty",
            "process_id": "plan_and_execute",
            "bpmn_path": "plan_and_execute.bpmn",
            "created_at": "2026-08-25T10:00:00Z",
        },
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        client = DaemonClient(base_url="http://test", token="test-token", workspace=ws, http_client=http_client)
        inbox = await client.get_inbox()

        assert len(inbox) >= 2
        types = [item["type"] for item in inbox]
        assert "human_task" in types
        assert "deferred_merge" in types

        human_item = next(item for item in inbox if item["type"] == "human_task")
        assert human_item["workflow_id"] == "run-human"
        assert human_item["task_name"] == "Review Plan"

        merge_item = next(item for item in inbox if item["type"] == "deferred_merge")
        assert merge_item["workflow_id"] == "run-deferred-merge"
        assert "dirty" in merge_item["merge_error"]

        await client.close()


def test_form_schema_parsing_and_native_support() -> None:
    schema_dict = {
        "type": "default",
        "components": [
            {
                "key": "plan_approval",
                "label": "Approval Decision",
                "type": "textfield",
                "defaultValue": "approved",
            },
            {
                "key": "human_answers",
                "label": "Clarifications",
                "type": "textarea",
            },
            {
                "key": "replicas",
                "label": "Replicas",
                "type": "number",
                "defaultValue": 3,
            },
            {
                "key": "auto_deploy",
                "label": "Auto Deploy",
                "type": "checkbox",
                "defaultValue": True,
            },
            {
                "key": "env",
                "label": "Environment",
                "type": "select",
                "values": [{"label": "Staging", "value": "stg"}, {"label": "Prod", "value": "prd"}],
            },
        ],
    }

    schema = FormSchema.from_dict(schema_dict)
    assert schema.is_native_supported is True
    assert len(schema.fields) == 5

    defaults = schema.extract_defaults()
    assert defaults["plan_approval"] == "approved"
    assert defaults["replicas"] == 3
    assert defaults["auto_deploy"] is True
    assert defaults["human_answers"] == ""


def test_form_schema_unsupported_complex_components() -> None:
    schema_dict = {
        "type": "default",
        "components": [
            {"key": "title", "label": "Title", "type": "textfield"},
            {"key": "matrix", "label": "Custom Matrix", "type": "dynamiclist"},
        ],
    }

    schema = FormSchema.from_dict(schema_dict)
    assert schema.is_native_supported is False
    assert "dynamiclist" in schema.unsupported_types


def test_daemon_client_tail_logs(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    log_file = ws.logs_dir / "graph-agent.log"
    log_file.write_text("line 1\nline 2\nline 3\n", encoding="utf-8")

    client = DaemonClient(base_url="http://test", workspace=ws)
    tail = client.tail_logs(max_lines=2)
    assert "line 2\nline 3" in tail


def test_tui_screens_instantiation(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    client = DaemonClient(base_url="http://test", workspace=ws)

    runs_screen = RunsScreen()
    assert runs_screen is not None

    detail_screen = RunDetailScreen(workflow_id="wf-123")
    assert detail_screen.workflow_id == "wf-123"

    inbox_screen = InboxScreen()
    assert inbox_screen is not None

    form_screen = FormScreen(workflow_id="wf-123", task_id="task-456")
    assert form_screen.workflow_id == "wf-123"
    assert form_screen.task_id == "task-456"

    start_screen = StartScreen()
    assert start_screen is not None

    log_screen = LogScreen()
    assert log_screen is not None

    from graph_agent.tui.screens.command_palette import CommandPaletteModal
    from graph_agent.tui.screens.diff_modal import DiffModalScreen
    from graph_agent.tui.screens.session_chat import SessionChatScreen
    from graph_agent.tui.screens.session_picker import SessionPickerScreen

    session_picker = SessionPickerScreen()
    assert session_picker is not None

    session_chat = SessionChatScreen(workflow_id="wf-123")
    assert session_chat.workflow_id == "wf-123"

    palette = CommandPaletteModal()
    assert palette is not None

    diff_modal = DiffModalScreen(workflow_id="wf-123")
    assert diff_modal.workflow_id == "wf-123"

    app = GraphAgentApp(client=client, workspace=ws)
    assert app.TITLE in ("bpmn", "graph-agent")


def test_cli_attach_not_running(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    main(["attach", "--workspace", str(tmp_path)])
    out = capsys.readouterr().out
    assert "No daemon running" in out


@pytest.mark.anyio
async def test_data_table_out_of_bounds_click_safe(tmp_path: Path) -> None:
    """Verify that clicking outside header bounds on DataTable does not raise IndexError."""
    from rich.style import Style
    from textual.events import Click
    from textual.widgets import DataTable

    ws = Workspace.discover(tmp_path)
    client = DaemonClient(base_url="http://test", workspace=ws)
    app = GraphAgentApp(client=client, workspace=ws)

    async with app.run_test() as pilot:
        # Get DataTable on active RunsScreen
        table = pilot.app.screen.query_one(DataTable)
        # Out-of-bounds column click on header (row = -1)
        event = Click(
            widget=table,
            x=999,
            y=0,
            delta_x=0,
            delta_y=0,
            button=1,
            shift=False,
            meta=False,
            ctrl=False,
            style=Style(meta={"row": -1, "column": 999, "out_of_bounds": True}),
        )
        # Must not raise IndexError
        await table._on_click(event)


@pytest.mark.anyio
async def test_tui_screens_pilot(mock_daemon: tuple[Workspace, WorkflowService, Any]) -> None:
    ws, _service, asgi_app = mock_daemon
    transport = ASGITransport(app=asgi_app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        client = DaemonClient(base_url="http://test", token="test-token", workspace=ws, http_client=http_client)
        app = GraphAgentApp(client=client, workspace=ws)
        async with app.run_test() as pilot:
            from graph_agent.tui.screens.command_palette import CommandPaletteModal
            from graph_agent.tui.screens.detail import RunDetailScreen
            from graph_agent.tui.screens.diff_modal import DiffModalScreen
            from graph_agent.tui.screens.session_chat import SessionChatScreen

            await pilot.press("r")
            await pilot.pause(0.05)

            # Test Detail Screen
            detail = RunDetailScreen(workflow_id="wf-test")
            app.push_screen(detail)
            await pilot.pause(0.05)
            await detail.action_refresh_detail()
            await pilot.press("escape")

            # Test Session Chat Screen
            chat = SessionChatScreen(workflow_id="wf-test")
            app.push_screen(chat)
            await pilot.pause(0.05)
            await chat.action_refresh_session()
            await pilot.press("escape")

            # Test Command Palette
            palette = CommandPaletteModal()
            app.push_screen(palette)
            await pilot.pause(0.05)
            await pilot.press("escape")

            # Test Diff Modal
            diff_m = DiffModalScreen(workflow_id="wf-test")
            app.push_screen(diff_m)
            await pilot.pause(0.05)
            await pilot.press("escape")

