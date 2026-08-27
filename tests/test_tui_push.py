import pytest
from httpx import ASGITransport, AsyncClient

from graph_agent.agents_root import Workspace
from graph_agent.api.server import create_app
from graph_agent.persistence import WorkflowStore
from graph_agent.tui.app import GraphAgentApp
from graph_agent.tui.client import DaemonClient
from graph_agent.tui.screens.detail import RunDetailScreen
from graph_agent.tui.screens.form import FormScreen
from graph_agent.tui.screens.inbox import InboxScreen
from graph_agent.tui.screens.log import LogScreen
from graph_agent.tui.screens.runs import RunsScreen
from graph_agent.tui.screens.start import StartScreen
from graph_agent.workflow_service import WorkflowService


@pytest.fixture
def mock_daemon(tmp_path):
    ws = Workspace.discover(tmp_path)
    ws.ensure()
    store = WorkflowStore(":memory:")
    service = WorkflowService(store=store, workspace=ws)
    app = create_app(service, workspace=ws)
    return ws, service, app


@pytest.mark.anyio
async def test_tui_push_screens(mock_daemon):
    ws, _service, app = mock_daemon
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        client = DaemonClient(base_url="http://test", token="test-token", workspace=ws, http_client=http_client)
        tui_app = GraphAgentApp(client=client, workspace=ws)

        start_res = await http_client.post(
            "/workflow/start",
            json={
                "bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn",
                "variables": {"goal": "test"},
            },
        )
        run_id = start_res.json()["workflow_id"]

        async with tui_app.run_test(size=(120, 40)) as pilot:
            await pilot.pause()

            screens = [
                StartScreen(),
                RunDetailScreen(run_id, "plan"),
                FormScreen(run_id, "task-1"),
                InboxScreen(),
                LogScreen(run_id),
                RunsScreen(),
            ]

            for s in screens:
                tui_app.push_screen(s)
                await pilot.pause()
                try:
                    for b in tui_app.screen.query("Button"):
                        await pilot.click(b.__class__)
                except Exception:
                    pass
                # Don't pop, just push on top
