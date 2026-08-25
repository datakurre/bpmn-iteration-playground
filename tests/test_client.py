"""DaemonClient against a real FastAPI app over httpx.ASGITransport -- no real socket, but
otherwise the genuine HTTP wire path (headers, status codes, JSON bodies, SSE framing) a
CLI verb's DaemonClient.for_workspace() call goes through against an actual `bpmn serve`.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from bpmn_agent.api.server import create_app
from bpmn_agent.client import DaemonClient, DaemonRequestError
from bpmn_agent.daemon import RUNTIME_SCHEMA_VERSION, RuntimeInfo
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.workflow_service import WorkflowService

TOKEN = "test-daemon-token"


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


def _runtime_info(token: str) -> RuntimeInfo:
    return RuntimeInfo(
        schema=RUNTIME_SCHEMA_VERSION,
        pid=0,
        port=0,
        url="http://daemon.invalid",
        token=token,
        started_at=datetime.now(UTC).isoformat(),
    )


@pytest.fixture
def daemon_client(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ADMIN_TOKEN", TOKEN)
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, _FakePi())
    app = create_app(service)
    transport = httpx.ASGITransport(app=app)
    client = DaemonClient(_runtime_info(TOKEN), transport=transport)
    yield client, service, store, transport


@pytest.mark.anyio
async def test_start_returns_the_new_instance_state(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        state = await client.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {"x": 1})
    assert state["status"] in ("running", "waiting_pi", "completed")
    assert state["process_id"] == "sequential_agents"
    store.close()


@pytest.mark.anyio
async def test_list_instances_sees_a_started_workflow(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        started = await client.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
        instances = await client.list_instances()
    assert any(item["workflow_id"] == started["workflow_id"] for item in instances)
    store.close()


@pytest.mark.anyio
async def test_state_round_trips_a_started_workflow(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        started = await client.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
        fetched = await client.state(started["workflow_id"])
    assert fetched["workflow_id"] == started["workflow_id"]
    store.close()


@pytest.mark.anyio
async def test_state_of_unknown_workflow_raises_daemon_request_error(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        with pytest.raises(DaemonRequestError) as excinfo:
            await client.state("does-not-exist")
    assert excinfo.value.status_code == 404
    store.close()


@pytest.mark.anyio
async def test_cancel_transitions_a_running_workflow(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        started = await client.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
        cancelled = await client.cancel(started["workflow_id"])
    assert cancelled["status"] == "cancelled"
    store.close()


@pytest.mark.anyio
async def test_merge_of_a_not_yet_completed_workflow_raises_daemon_request_error_400(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        started = await client.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
        # sequential_agents.bpmn has two tasks and dispatch is async, so the workflow is
        # not yet "completed" the instant start() returns -- merge() must refuse it.
        assert started["status"] != "completed"
        with pytest.raises(DaemonRequestError) as excinfo:
            await client.merge(started["workflow_id"])
    assert excinfo.value.status_code == 400
    store.close()


@pytest.mark.anyio
async def test_wrong_token_raises_daemon_request_error_401(daemon_client) -> None:
    _client, _service, store, transport = daemon_client
    wrong_client = DaemonClient(_runtime_info("wrong"), transport=transport)
    async with wrong_client:
        with pytest.raises(DaemonRequestError) as excinfo:
            await wrong_client.state("anything")
    assert excinfo.value.status_code == 401
    store.close()


@pytest.mark.anyio
async def test_stream_events_yields_the_initial_state_then_closes(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        started = await client.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
        events = [event async for event in client.stream_events(started["workflow_id"])]
    assert events
    assert events[0]["workflow_id"] == started["workflow_id"]
    store.close()


@pytest.mark.anyio
async def test_stream_events_of_unknown_workflow_raises_daemon_request_error(daemon_client) -> None:
    client, _service, store, _transport = daemon_client
    async with client:
        with pytest.raises(DaemonRequestError) as excinfo:
            async for _ in client.stream_events("does-not-exist"):
                pass
    assert excinfo.value.status_code == 404
    store.close()
