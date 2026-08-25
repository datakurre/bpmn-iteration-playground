import asyncio
from pathlib import Path

from fastapi.testclient import TestClient


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ui_pages_render_html(client: TestClient) -> None:
    for path in ["/", "/history", "/editor", "/admin"]:
        response = client.get(path)
        assert response.status_code == 200
        assert "text/html" in response.headers.get("content-type", "")


def test_instance_page_404_for_missing(client: TestClient) -> None:
    response = client.get("/instance/nonexistent-wf")
    assert response.status_code == 404


def test_start_and_get_workflow_state(client: TestClient) -> None:
    response = client.post(
        "/workflow/start",
        json={"bpmn_path": "graph_agent/data/workflows/contract_review.bpmn", "variables": {"contract": "Test Agreement"}},
    )
    assert response.status_code == 200
    data = response.json()
    assert "workflow_id" in data
    wf_id = data["workflow_id"]

    state_resp = client.get(f"/workflow/{wf_id}/state")
    assert state_resp.status_code == 200
    assert state_resp.json()["workflow_id"] == wf_id

    instance_page_resp = client.get(f"/instance/{wf_id}")
    assert instance_page_resp.status_code == 200
    assert "text/html" in instance_page_resp.headers.get("content-type", "")


def test_get_nonexistent_workflow_state(client: TestClient) -> None:
    response = client.get("/workflow/missing-id/state")
    assert response.status_code == 404


def test_template_registry_endpoints(client: TestClient) -> None:
    list_resp = client.get("/api/templates")
    assert list_resp.status_code == 200
    templates = list_resp.json()
    assert len(templates) >= 2
    assert any(t["id"] == "contract_review" for t in templates)

    detail_resp = client.get("/api/templates/contract_review")
    assert detail_resp.status_code == 200
    assert detail_resp.json()["id"] == "contract_review"

    xml_resp = client.get("/api/templates/contract_review/xml")
    assert xml_resp.status_code == 200
    assert "bpmn:definitions" in xml_resp.text

    missing_resp = client.get("/api/templates/nonexistent_template")
    assert missing_resp.status_code == 404


def test_element_templates_endpoint(client: TestClient) -> None:
    response = client.get("/api/element-templates")
    assert response.status_code == 200
    templates = response.json()
    ids = {t["id"] for t in templates}
    assert "playground.pi-agent-task" in ids
    assert "playground.shell-task" in ids
    for template in templates:
        assert template["appliesTo"] == ["bpmn:ServiceTask"]
        assert isinstance(template["properties"], list)


def test_workflow_save_endpoint(client: TestClient) -> None:
    valid_xml = """<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_Test" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="test_saved_process" isExecutable="true">
    <bpmn:startEvent id="Start_1" />
  </bpmn:process>
</bpmn:definitions>"""

    resp = client.post("/api/workflows/save", json={"name": "test_saved_process", "xml": valid_xml})
    assert resp.status_code == 200
    assert "test_saved_process.bpmn" in resp.json()["path"]

    # Cleanup generated file
    test_file = Path(resp.json()["path"])
    if test_file.exists():
        test_file.unlink()

    invalid_resp = client.post("/api/workflows/save", json={"name": "bad", "xml": "<not-valid-bpmn>"})
    assert invalid_resp.status_code == 400


def test_submit_task_validation(client: TestClient) -> None:
    start_resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "graph_agent/data/workflows/contract_review.bpmn", "variables": {"contract": "Test"}},
    )
    wf_id = start_resp.json()["workflow_id"]

    # Invalid task ID
    invalid_resp = client.post(
        f"/workflow/{wf_id}/submit-task/nonexistent-task",
        json={"variables": {"decision": "approved"}},
    )
    assert invalid_resp.status_code == 409

    # Body without task_id
    body_resp = client.post(f"/workflow/{wf_id}/submit-task", json={"variables": {}})
    assert body_resp.status_code == 422


def test_download_workspace_endpoint(client: TestClient) -> None:
    start_resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "graph_agent/data/workflows/contract_review.bpmn", "variables": {"contract": "Test"}},
    )
    wf_id = start_resp.json()["workflow_id"]

    ws_resp = client.get(f"/instance/{wf_id}/workspace")
    assert ws_resp.status_code == 200
    assert "application/zstd" in ws_resp.headers["content-type"]
    assert len(ws_resp.content) > 0

    missing_resp = client.get("/instance/nonexistent-wf/workspace")
    assert missing_resp.status_code == 404


def test_request_logging_middleware_handles_errors() -> None:
    from fastapi import FastAPI

    from graph_agent.logging_config import RequestLoggingMiddleware

    test_app = FastAPI()
    test_app.add_middleware(RequestLoggingMiddleware)

    @test_app.get("/crash")
    def crash():
        raise RuntimeError("Intentional crash")

    test_client = TestClient(test_app, raise_server_exceptions=False)
    resp = test_client.get("/crash")
    assert resp.status_code == 500


def test_configure_logging_preserves_external_handlers() -> None:
    import logging

    from graph_agent.logging_config import configure_logging

    root = logging.getLogger()
    custom_handler = logging.NullHandler()
    root.addHandler(custom_handler)

    try:
        configure_logging(level="INFO", log_file=None)
        assert custom_handler in root.handlers
    finally:
        if custom_handler in root.handlers:
            root.removeHandler(custom_handler)


def test_cancel_workflow_endpoint(client: TestClient) -> None:
    start_resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "graph_agent/data/workflows/contract_review.bpmn", "variables": {"contract": "Cancel Test"}},
    )
    wf_id = start_resp.json()["workflow_id"]

    cancel_resp = client.post(f"/instance/{wf_id}/cancel")
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "cancelled"

    # Missing instance returns 404
    missing_cancel = client.post("/instance/missing-wf/cancel")
    assert missing_cancel.status_code == 404


def test_start_workflow_invalid_bpmn_input(client: TestClient) -> None:
    resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "graph_agent/data/workflows/non_existent.bpmn", "variables": {}},
    )
    assert resp.status_code == 404


def test_prometheus_metrics_endpoint(client: TestClient) -> None:
    resp = client.get("/metrics")
    assert resp.status_code == 200
    text = resp.text
    assert "bpmn_instances_total" in text
    assert "bpmn_zodb_storage_bytes" in text
    assert "bpmn_active_background_jobs" in text


def test_sse_events_stream_endpoint(client: TestClient) -> None:
    start_resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "graph_agent/data/workflows/contract_review.bpmn", "variables": {"contract": "SSE Test"}},
    )
    wf_id = start_resp.json()["workflow_id"]

    # Missing instance returns 404
    missing = client.get("/instance/missing-id/events/stream")
    assert missing.status_code == 404

    # Valid instance stream
    from unittest import mock
    with (
        mock.patch("asyncio.sleep", new_callable=mock.AsyncMock, side_effect=asyncio.CancelledError),
        client.stream("GET", f"/instance/{wf_id}/events/stream") as stream_resp,
    ):
        assert stream_resp.status_code == 200
        for chunk in stream_resp.iter_text():
            assert "data:" in chunk
            break





