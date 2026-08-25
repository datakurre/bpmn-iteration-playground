import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from bpmn_agent.api.server import create_app
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.workflow_service import WorkflowService


def _client() -> TestClient:
    service = WorkflowService(WorkflowStore(":memory:"))
    return TestClient(create_app(service))


def test_request_with_no_origin_header_passes() -> None:
    with _client() as client:
        resp = client.get("/health")
    assert resp.status_code == 200


def test_request_with_matching_origin_passes() -> None:
    with _client() as client:
        # TestClient's default Host header is "testserver".
        resp = client.get("/health", headers={"Origin": "http://testserver"})
    assert resp.status_code == 200


def test_request_with_mismatched_origin_is_blocked() -> None:
    with _client() as client:
        resp = client.get("/health", headers={"Origin": "https://evil.example"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Cross-origin request blocked"


def test_post_with_mismatched_origin_is_blocked_before_reaching_the_route() -> None:
    with _client() as client:
        resp = client.post(
            "/workflow/start",
            json={"bpmn_path": "bpmn_agent/data/workflows/contract_review.bpmn", "variables": {}},
            headers={"Origin": "https://evil.example"},
        )
    assert resp.status_code == 403


def test_websocket_with_mismatched_origin_is_closed() -> None:
    with _client() as client, pytest.raises(WebSocketDisconnect) as exc_info, client.websocket_connect(
        "/ws/instance/nonexistent", headers={"Origin": "https://evil.example"}
    ):
        pass
    assert exc_info.value.code == 4403


def test_websocket_with_matching_origin_connects() -> None:
    with (
        _client() as client,
        client.websocket_connect("/ws/instance/nonexistent", headers={"Origin": "http://testserver"}) as ws,
    ):
        ws.close()
