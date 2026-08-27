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
        json={
            "bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn",
            "variables": {"contract": "History test"},
        },
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

    # Clear all instances requires confirmation guard
    client.post(
        "/workflow/start", json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn", "variables": {}}
    )
    unconfirmed = client.delete("/api/history/instances")
    assert unconfirmed.status_code == 400

    clear_resp = client.delete("/api/history/instances?confirm=DELETE_ALL")
    assert clear_resp.status_code == 200
    assert clear_resp.json()["deleted"] >= 1
    assert client.get("/api/history/instances").json() == []


def test_history_instances_pagination_and_date_filtering(client: TestClient) -> None:
    client.delete("/api/history/instances?confirm=DELETE_ALL")

    # Create 5 instances
    wf_ids = []
    for i in range(5):
        resp = client.post(
            "/workflow/start",
            json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn", "variables": {"idx": i}},
        )
        wf_ids.append(resp.json()["workflow_id"])

    # Test limit
    res_limit = client.get("/api/history/instances?limit=2").json()
    assert len(res_limit) == 2

    # Test offset
    res_offset = client.get("/api/history/instances?offset=3&limit=2").json()
    assert len(res_offset) == 2

    # Test date filtering
    all_res = client.get("/api/history/instances").json()
    assert len(all_res) == 5
    all_res[0]["created_at"]
    # filter since futuristic date returns 0
    future_res = client.get("/api/history/instances?since=2099-01-01T00:00:00Z").json()
    assert len(future_res) == 0

    # filter until futuristic date returns all 5
    past_res = client.get("/api/history/instances?until=2099-01-01T00:00:00Z").json()
    assert len(past_res) == 5


def test_history_sessions_endpoints(client: TestClient) -> None:
    # Initially empty
    assert client.get("/api/history/sessions").json() == []

    # Start a workflow that records a session
    resp = client.post(
        "/workflow/start",
        json={
            "bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn",
            "variables": {"contract": "Session Test"},
        },
    )
    assert resp.status_code == 200

    sessions = client.get("/api/history/sessions").json()
    # If any session was recorded, inspect it
    if sessions:
        sess_id = sessions[0]["session_id"]
        detail_resp = client.get(f"/api/history/sessions/{sess_id}")
        assert detail_resp.status_code == 200
        assert detail_resp.json()["session_id"] == sess_id

    # 404 for non-existent session
    missing = client.get("/api/history/sessions/non-existent-sess-id")
    assert missing.status_code == 404


def test_history_purge_and_reindex_endpoints(client: TestClient) -> None:
    # Start two workflows
    resp1 = client.post(
        "/workflow/start",
        json={
            "bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn",
            "variables": {"contract": "Test 1"},
        },
    )
    assert resp1.status_code == 200
    wf_id1 = resp1.json()["workflow_id"]

    # Cancel one workflow so its status becomes cancelled
    cancel_resp = client.post(f"/instance/{wf_id1}/cancel")
    assert cancel_resp.status_code == 200

    # Reindex
    reindex_resp = client.post("/api/history/reindex")
    assert reindex_resp.status_code == 200
    assert reindex_resp.json()["reindexed"] >= 1

    # Bulk purge cancelled/completed
    purge_resp = client.post("/api/history/purge?status=cancelled,completed")
    assert purge_resp.status_code == 200
    assert purge_resp.json()["purged"] >= 1

