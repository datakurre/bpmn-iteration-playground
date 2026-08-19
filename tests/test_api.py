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
        json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {"contract": "Test Agreement"}},
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
        json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {"contract": "Test"}},
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
        json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {"contract": "Test"}},
    )
    wf_id = start_resp.json()["workflow_id"]

    ws_resp = client.get(f"/instance/{wf_id}/workspace")
    assert ws_resp.status_code == 200
    assert "application/zstd" in ws_resp.headers["content-type"]
    assert len(ws_resp.content) > 0

    missing_resp = client.get("/instance/nonexistent-wf/workspace")
    assert missing_resp.status_code == 404

