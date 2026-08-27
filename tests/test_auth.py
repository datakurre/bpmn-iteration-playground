from fastapi.testclient import TestClient


def test_auth_disabled_by_default(client: TestClient, monkeypatch) -> None:
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    monkeypatch.delenv("API_KEYS", raising=False)

    # Health check is public
    assert client.get("/health").status_code == 200

    # Start workflow allowed
    resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn", "variables": {}},
    )
    assert resp.status_code == 200


def test_rbac_with_api_keys(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("API_KEYS", "view-key:viewer,op-key:operator,adm-key:admin")
    monkeypatch.setenv("ADMIN_TOKEN", "secret-admin-token")

    # 1. Public health check works without credentials
    assert client.get("/health").status_code == 200

    # 2. Unauthenticated request to protected endpoint returns 401
    assert (
        client.post(
            "/workflow/start", json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn"}
        ).status_code
        == 401
    )
    assert client.get("/api/history/instances").status_code == 401
    assert client.get("/api/templates").status_code == 401

    # 3. Viewer key can read but not mutate
    viewer_headers = {"X-Api-Key": "view-key"}
    assert client.get("/api/history/instances", headers=viewer_headers).status_code == 200
    assert client.get("/api/templates", headers=viewer_headers).status_code == 200
    assert (
        client.post(
            "/workflow/start",
            json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn"},
            headers=viewer_headers,
        ).status_code
        == 403
    )

    # 4. Operator key can start workflows and submit tasks
    op_headers = {"X-Api-Key": "op-key"}
    start_resp = client.post(
        "/workflow/start", json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn"}, headers=op_headers
    )
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
    admin_list = client.get("/api/history/instances", headers=token_headers)
    assert admin_list.status_code == 200


def test_require_auth_fails_when_unconfigured(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    monkeypatch.delenv("API_KEYS", raising=False)

    # When REQUIRE_AUTH is true and no tokens configured, protected endpoints must reject with 401/500/error instead of fail-open
    resp = client.post("/workflow/start", json={"bpmn_path": "graph_agent/data/workflows/plan_and_execute.bpmn"})
    assert resp.status_code in (401, 500)


def test_websocket_auth_required_when_configured(client: TestClient, monkeypatch) -> None:
    import pytest
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.setenv("API_KEYS", "ws-key:viewer")
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    monkeypatch.delenv("REQUIRE_AUTH", raising=False)

    # 1. Unauthenticated WS connection is rejected
    with pytest.raises(WebSocketDisconnect) as exc_info, client.websocket_connect("/ws/instance/dummy-wf"):
        pass
    assert exc_info.value.code == 1008

    # 2. Authenticated WS connection via header or query parameter succeeds
    with client.websocket_connect("/ws/instance/dummy-wf", headers={"X-Api-Key": "ws-key"}):
        pass
    with client.websocket_connect("/ws/instance/dummy-wf?api_key=ws-key"):
        pass


def test_ui_page_routes_require_auth(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("API_KEYS", "view-key:viewer,adm-key:admin")
    monkeypatch.setenv("ADMIN_TOKEN", "admin-secret")

    # Unauthenticated requests to UI pages return 401
    assert client.get("/").status_code == 401
    assert client.get("/history").status_code == 401
    assert client.get("/admin").status_code == 401
    assert client.get("/editor").status_code == 401

    # Viewer can access dashboard, history, editor
    viewer_headers = {"X-Api-Key": "view-key"}
    assert client.get("/", headers=viewer_headers).status_code == 200
    assert client.get("/history", headers=viewer_headers).status_code == 200
    assert client.get("/editor", headers=viewer_headers).status_code == 200
    # Viewer cannot access admin page
    assert client.get("/admin", headers=viewer_headers).status_code == 403


def test_auth_config_cached_and_invalidates_on_env_change(monkeypatch) -> None:
    from graph_agent.auth import Role, parse_auth_config

    monkeypatch.setenv("API_KEYS", "cached-key:operator")
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)

    _token1, keys1, _enabled1 = parse_auth_config()
    assert keys1["cached-key"] == Role.OPERATOR

    _token2, keys2, _enabled2 = parse_auth_config()
    assert keys1 is keys2  # Same cached dictionary instance

    monkeypatch.setenv("API_KEYS", "cached-key2:viewer")
    _token3, keys3, _enabled3 = parse_auth_config()
    assert "cached-key2" in keys3
    assert keys3["cached-key2"] == Role.VIEWER


def test_malformed_api_keys_handling(monkeypatch) -> None:
    from graph_agent.auth import Role, parse_auth_config

    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    # Test whitespace, empty items, unknown roles, keys without roles
    monkeypatch.setenv("API_KEYS", "  , key1:admin, , key2:invalid_role , key3:OPERATOR , key4 , key5:viewer:extra ")
    _token, keys, enabled = parse_auth_config()
    assert enabled is True
    assert keys.get("key1") == Role.ADMIN
    assert "key2" not in keys  # invalid role is skipped
    assert keys.get("key3") == Role.OPERATOR
    assert keys.get("key4") == Role.OPERATOR  # defaults to operator
    assert "key5" not in keys  # invalid role string skipped


def test_ui_page_query_and_cookie_auth(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("ADMIN_TOKEN", "admin-secret")
    monkeypatch.delenv("API_KEYS", raising=False)

    # 1. Loading with query param ?token=admin-secret succeeds and sets cookie
    resp = client.get("/editor?token=admin-secret")
    assert resp.status_code == 200
    assert "admin_token" in resp.cookies or "admin_token=admin-secret" in resp.headers.get("set-cookie", "")

    # 2. Subsequent request using the cookie succeeds
    cookie_client_resp = client.get("/editor", cookies={"admin_token": "admin-secret"})
    assert cookie_client_resp.status_code == 200

    # 3. Protected API endpoint with cookie succeeds
    api_resp = client.get("/api/templates", cookies={"admin_token": "admin-secret"})
    assert api_resp.status_code == 200

    # 4. Bearer authorization header succeeds
    bearer_resp = client.get("/api/templates", headers={"Authorization": "Bearer admin-secret"})
    assert bearer_resp.status_code == 200

    # 5. Invalid token in query returns 401
    assert client.get("/editor?token=wrong").status_code == 401
