import asyncio
from fastapi.testclient import TestClient
from app.events import WorkflowEvent, EventBus


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


def test_workflow_lifecycle_event_logging(service: WorkflowService) -> None:
    async def scenario() -> None:
        started = await service.start(
            "workflows/contract_review.bpmn", None, {"contract": "Event Test"}
        )
        wf_id = started["workflow_id"]
        while any(not job.done() for job in list(service.jobs.values())):
            await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])
            await asyncio.sleep(0.01)

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
