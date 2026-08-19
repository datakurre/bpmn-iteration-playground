from fastapi.testclient import TestClient


def test_auth_disabled_by_default(client: TestClient, monkeypatch) -> None:
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    monkeypatch.delenv("API_KEYS", raising=False)

    # Health check is public
    assert client.get("/health").status_code == 200

    # Start workflow allowed
    resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {}},
    )
    assert resp.status_code == 200


def test_rbac_with_api_keys(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("API_KEYS", "view-key:viewer,op-key:operator,adm-key:admin")
    monkeypatch.setenv("ADMIN_TOKEN", "secret-admin-token")

    # 1. Public health check works without credentials
    assert client.get("/health").status_code == 200

    # 2. Unauthenticated request to protected endpoint returns 401
    assert client.post("/workflow/start", json={"bpmn_path": "workflows/contract_review.bpmn"}).status_code == 401
    assert client.get("/api/history/instances").status_code == 401

    # 3. Viewer key can read but not mutate
    viewer_headers = {"X-Api-Key": "view-key"}
    assert client.get("/api/history/instances", headers=viewer_headers).status_code == 200
    assert client.post("/workflow/start", json={"bpmn_path": "workflows/contract_review.bpmn"}, headers=viewer_headers).status_code == 403

    # 4. Operator key can start workflows and submit tasks
    op_headers = {"X-Api-Key": "op-key"}
    start_resp = client.post("/workflow/start", json={"bpmn_path": "workflows/contract_review.bpmn"}, headers=op_headers)
    assert start_resp.status_code == 200
    wf_id = start_resp.json()["workflow_id"]

    # Operator cannot delete all instances (admin only)
    assert client.delete("/api/history/instances", headers=op_headers).status_code == 403

    # 5. Admin key can perform admin operations
    admin_headers = {"X-Api-Key": "adm-key"}
    del_resp = client.delete(f"/api/history/instances/{wf_id}", headers=admin_headers)
    assert del_resp.status_code == 200

    # 6. Admin token via X-Admin-Token header
    token_headers = {"X-Admin-Token": "secret-admin-token"}
    admin_list = client.get("/admin/instances", headers=token_headers)
    assert admin_list.status_code == 200
