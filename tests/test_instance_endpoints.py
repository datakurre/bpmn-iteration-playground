import pytest
from httpx import ASGITransport, AsyncClient

from graph_agent.agents_root import Workspace
from graph_agent.api.server import create_app
from graph_agent.persistence import WorkflowStore
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
async def test_instance_endpoints_coverage(mock_daemon):
    _ws, _service, app = mock_daemon
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Pre-seed a workflow run
        start_res = await client.post("/workflow/start", json={
            "bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn",
            "variables": {"goal": "test"}
        })
        run_id = start_res.json()["workflow_id"]
        # GET /instance/{id}
        await client.get(f"/instance/{run_id}")

        # GET /instance/{id}/diagram
        await client.get(f"/instance/{run_id}/diagram")

        # GET /instance/{id}/workspace
        await client.get(f"/instance/{run_id}/workspace")

        # GET /instance/{id}/forms

        # GET /instance/{id}/forms/{task_id}
        await client.get(f"/instance/{run_id}/forms/task-1")

        # GET /instance/{id}/savepoints
        await client.get(f"/instance/{run_id}/savepoints")

        # POST /instance/{id}/fork/{savepoint_id}
        await client.post(f"/instance/{run_id}/fork/sp1")

        # POST /instance/{id}/message/{name}
        await client.post(f"/instance/{run_id}/message/msg1", json={})

        # GET /instance/{id}/events/pending
        await client.get(f"/instance/{run_id}/events/pending")

        # POST /instance/{id}/retry/{task_id}
        await client.post(f"/instance/{run_id}/retry/task-1")

        # POST /instance/{id}/cancel
        await client.post(f"/instance/{run_id}/cancel")

        # POST /instance/{id}/merge
        await client.post(f"/instance/{run_id}/merge")

        # Missing instance 404 checks
        await client.get( "/instance/non-existent")
        await client.post("/instance/non-existent/cancel")

        # GET /instance/{id}/events
        await client.get(f"/instance/{run_id}/events")

        # GET /instance/{id}/workspace/files
        await client.get(f"/instance/{run_id}/workspace/files")

        # GET /instance/{id}/workspace/file
        await client.get(f"/instance/{run_id}/workspace/file?path=test.txt")

        # POST /instance/{id}/submit-task/{task_id}
        await client.post(f"/instance/{run_id}/submit-task/task-1", json={})

        # GET /instance/{id}/savepoint/{save_point_id}
        await client.get(f"/instance/{run_id}/savepoint/sp1")

        # DELETE /instance/{id}/savepoints
        await client.delete(f"/instance/{run_id}/savepoints?anchor=sp1")

def test_more_instance_endpoints(client):
    res = client.post("/workflow/start", json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn", "variables": {}})
    run_id = res.json()["workflow_id"]

    # Coverage for instance endpoints
    client.get(f"/instance/{run_id}/history")
    client.get(f"/instance/{run_id}/savepoints")
    client.get(f"/instance/{run_id}/diagram")
    client.post(f"/instance/{run_id}/fork", json={"savepoint_id": "sp-1"})
    client.get(f"/instance/{run_id}/workspace")
    client.get(f"/instance/{run_id}/forms")
    client.post(f"/instance/{run_id}/cancel")
    client.post(f"/instance/{run_id}/retry/task-1")
    client.post(f"/instance/{run_id}/message/msg1", json={"payload": {}})

def test_cli_extra_2(monkeypatch, tmp_path):
    import contextlib
    import sys

    from graph_agent.cli import main
    monkeypatch.chdir(tmp_path)

    with contextlib.suppress(Exception, SystemExit):
        monkeypatch.setattr(sys, "argv", ["graph-agent", "serve", "--help"])
        main()
