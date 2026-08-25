import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from bpmn_agent.events import EventBus, WorkflowEvent
from bpmn_agent.workflow_service import WorkflowService


def test_webhook_crud_api(client: TestClient) -> None:
    # 1. Register webhook
    reg_resp = client.post(
        "/api/webhooks",
        json={"url": "https://example.com/hook", "events": ["workflow_completed", "pi_failed"]},
    )
    assert reg_resp.status_code == 200
    wh = reg_resp.json()
    assert "id" in wh
    assert wh["url"] == "https://example.com/hook"
    assert wh["events"] == ["workflow_completed", "pi_failed"]
    wh_id = wh["id"]

    # 2. List webhooks
    list_resp = client.get("/api/webhooks")
    assert list_resp.status_code == 200
    webhooks = list_resp.json()
    assert len(webhooks) == 1
    assert webhooks[0]["id"] == wh_id

    # 3. Delete webhook
    del_resp = client.delete(f"/api/webhooks/{wh_id}")
    assert del_resp.status_code == 200
    assert del_resp.json() == {"deleted": True}

    # 4. Delete missing webhook
    del_missing = client.delete(f"/api/webhooks/{wh_id}")
    assert del_missing.status_code == 404

    # 5. Invalid URL schemes rejected
    invalid_resp = client.post("/api/webhooks", json={"url": "file:///etc/passwd"})
    assert invalid_resp.status_code == 422



def test_workflow_lifecycle_event_logging(service: WorkflowService) -> None:
    async def scenario() -> None:
        started = await service.start(
            "workflows/contract_review.bpmn", None, {"contract": "Event Test"}
        )
        wf_id = started["workflow_id"]
        async def _wait():
            while any(not job.done() for job in list(service.jobs.values())):
                pending = [j for j in list(service.jobs.values()) if not j.done()]
                if pending:
                    await asyncio.gather(*pending)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait(), timeout=5.0)

        events = service.store.get_events(wf_id)
        event_types = [e["event_type"] for e in events]
        assert "workflow_started" in event_types
        assert "pi_started" in event_types
        assert "pi_completed" in event_types
        assert "human_task_ready" in event_types

    asyncio.run(scenario())


def test_event_bus_delivery_resilience() -> None:
    bus = EventBus(store=None)
    event = bus.emit("test_event", "wf-123", data={"foo": "bar"})
    assert event.event_type == "test_event"
    assert event.workflow_id == "wf-123"
    assert event.data == {"foo": "bar"}


def test_event_bus_tracks_pending_tasks() -> None:
    class DummyStore:
        def append_event(self, wf_id: str, ev: dict) -> None:
            pass
        def list_webhooks(self) -> list[dict]:
            return [{"url": "http://127.0.0.1:9999/hook", "events": ["test_event"]}]

    async def scenario() -> None:
        bus = EventBus(store=DummyStore())
        assert hasattr(bus, "_pending_tasks")
        bus.emit("test_event", "wf-123")
        assert len(bus._pending_tasks) == 1
        # Wait for delivery attempt to complete and verify task cleanup
        await asyncio.gather(*list(bus._pending_tasks), return_exceptions=True)
        assert len(bus._pending_tasks) == 0

    asyncio.run(scenario())


@pytest.mark.anyio
async def test_webhook_delivery_retry_and_failure(monkeypatch) -> None:
    from unittest.mock import AsyncMock, MagicMock

    from bpmn_agent.events import EventBus, WorkflowEvent

    bus = EventBus(store=None)
    event = WorkflowEvent(event_type="workflow_completed", workflow_id="wf-99")

    # 1. Total failure after retries
    attempt_count = 0
    async def failing_post(*args, **kwargs):
        nonlocal attempt_count
        attempt_count += 1
        raise httpx.ConnectError("Connection refused")

    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(httpx.AsyncClient, "post", failing_post)

    success = await bus._deliver_webhook("http://example.com/webhook", event, retries=3)
    assert success is False
    assert attempt_count == 3

    # 2. Success on second retry
    call_count = 0
    mock_resp = MagicMock()
    mock_resp.status_code = 200

    async def retry_success_post(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count < 2:
            raise httpx.ConnectError("Temporary glitch")
        return mock_resp

    monkeypatch.setattr(httpx.AsyncClient, "post", retry_success_post)
    success2 = await bus._deliver_webhook("http://example.com/webhook", event, retries=3)
    assert success2 is True
    assert call_count == 2


@pytest.mark.anyio
async def test_webhook_hmac_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    from unittest.mock import MagicMock
    bus = EventBus(store=None)
    event = WorkflowEvent(event_type="workflow_completed", workflow_id="wf-hmac")

    captured_headers = {}
    mock_resp = MagicMock()
    mock_resp.status_code = 200

    async def capture_post(*args, **kwargs):
        nonlocal captured_headers
        captured_headers = kwargs.get("headers", {})
        return mock_resp

    monkeypatch.setattr(httpx.AsyncClient, "post", capture_post)
    await bus._deliver_webhook("http://example.com/webhook", event, secret="test-secret-key")
    assert "X-Webhook-Signature" in captured_headers
    assert captured_headers["X-Webhook-Signature"].startswith("sha256=")





def test_event_bus_swallows_append_event_errors() -> None:
    class FailingAppendStore:
        def append_event(self, wf_id: str, ev: dict) -> None:
            raise RuntimeError("store unavailable")

    bus = EventBus(store=FailingAppendStore())
    event = bus.emit("test_event", "wf-123")  # must not raise
    assert event.event_type == "test_event"


def test_event_bus_swallows_list_webhooks_errors() -> None:
    class FailingListStore:
        def append_event(self, wf_id: str, ev: dict) -> None:
            pass

        def list_webhooks(self):
            raise RuntimeError("webhook store unavailable")

    bus = EventBus(store=FailingListStore())
    event = bus.emit("test_event", "wf-123")  # must not raise
    assert event.event_type == "test_event"


def test_event_bus_skips_webhooks_not_subscribed_to_event_type() -> None:
    class FilteredStore:
        def append_event(self, wf_id: str, ev: dict) -> None:
            pass

        def list_webhooks(self):
            return [{"url": "http://127.0.0.1:9999/hook", "events": ["other_event"]}]

    async def scenario() -> None:
        bus = EventBus(store=FilteredStore())
        bus.emit("test_event", "wf-123")
        # No matching webhook subscription -> no delivery task scheduled
        assert len(bus._pending_tasks) == 0

    asyncio.run(scenario())


@pytest.mark.anyio
async def test_webhook_delivery_retries_on_non_2xx_status(monkeypatch: pytest.MonkeyPatch) -> None:
    from unittest.mock import AsyncMock, MagicMock

    bus = EventBus(store=None)
    event = WorkflowEvent(event_type="workflow_completed", workflow_id="wf-status")

    error_resp = MagicMock()
    error_resp.status_code = 500

    call_count = 0

    async def error_status_post(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return error_resp

    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(httpx.AsyncClient, "post", error_status_post)

    success = await bus._deliver_webhook("http://example.com/webhook", event, retries=3)
    assert success is False
    assert call_count == 3
