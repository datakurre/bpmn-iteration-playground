from fastapi.testclient import TestClient


def test_history_storage_and_pack_endpoints(client: TestClient) -> None:
    storage_resp = client.get("/api/history/storage")
    assert storage_resp.status_code == 200
    data = storage_resp.json()
    assert "instances_count" in data
    assert "save_points_count" in data
    assert "size_human" in data

    pack_resp = client.post("/api/history/pack")
    assert pack_resp.status_code == 200
    pack_data = pack_resp.json()
    assert "reclaimed_human" in pack_data
    assert "size_after_human" in pack_data


def test_history_instances_listing_and_deletion(client: TestClient) -> None:
    # Initially empty
    assert client.get("/api/history/instances").json() == []

    # Start a workflow
    start_resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {"contract": "History test"}},
    )
    wf_id = start_resp.json()["workflow_id"]

    instances = client.get("/api/history/instances").json()
    assert len(instances) == 1
    assert instances[0]["workflow_id"] == wf_id

    # Filter by status
    filtered = client.get("/api/history/instances?status=waiting_human").json()
    assert isinstance(filtered, list)

    # Delete single instance
    del_resp = client.delete(f"/api/history/instances/{wf_id}")
    assert del_resp.status_code == 200
    assert del_resp.json() == {"deleted": wf_id}

    # Delete 404 for missing
    del_missing = client.delete(f"/api/history/instances/{wf_id}")
    assert del_missing.status_code == 404

    # Clear all instances
    client.post("/workflow/start", json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {}})
    clear_resp = client.delete("/api/history/instances")
    assert clear_resp.status_code == 200
    assert clear_resp.json()["deleted"] >= 1
    assert client.get("/api/history/instances").json() == []
