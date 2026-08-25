from fastapi.testclient import TestClient


def test_create_list_get_and_spawn_via_http(client: TestClient) -> None:
    create_resp = client.post("/project", json={"name": "Firmware Rewrite"})
    assert create_resp.status_code == 200
    created = create_resp.json()
    assert created["slug"] == "firmware-rewrite"
    assert created["child_count"] == 0

    list_resp = client.get("/project")
    assert list_resp.status_code == 200
    assert [p["slug"] for p in list_resp.json()] == ["firmware-rewrite"]

    get_resp = client.get("/project/firmware-rewrite")
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == "Firmware Rewrite"

    spawn_resp = client.post("/project/firmware-rewrite/spawn", json={"task_brief": "add CRC check"})
    assert spawn_resp.status_code == 200

    detail_resp = client.get("/project/firmware-rewrite")
    assert detail_resp.json()["child_count"] == 1
    assert detail_resp.json()["children"][0]["task_brief"] == "add CRC check"


def test_get_unknown_project_is_404(client: TestClient) -> None:
    resp = client.get("/project/does-not-exist")
    assert resp.status_code == 404


def test_duplicate_project_name_is_409(client: TestClient) -> None:
    assert client.post("/project", json={"name": "Alpha"}).status_code == 200
    dup_resp = client.post("/project", json={"name": "alpha"})
    assert dup_resp.status_code == 409


def test_spawn_into_unknown_project_is_404(client: TestClient) -> None:
    resp = client.post("/project/does-not-exist/spawn", json={"task_brief": "x"})
    assert resp.status_code == 404


def test_current_workspace_project_endpoints(client: TestClient) -> None:
    # When no project exists, current returns 404
    assert client.get("/project/current").status_code == 404
    assert client.post("/project/spawn", json={"task_brief": "first task"}).status_code == 404

    # Create a project
    create_resp = client.post("/project", json={"name": "Workspace Project"})
    assert create_resp.status_code == 200

    # /project/current now resolves to the active workspace project
    current_resp = client.get("/project/current")
    assert current_resp.status_code == 200
    assert current_resp.json()["name"] == "Workspace Project"

    # /project/spawn without a slug spawns into current
    spawn_resp = client.post("/project/spawn", json={"task_brief": "workspace task"})
    assert spawn_resp.status_code == 200

    detail_resp = client.get("/project/current")
    assert detail_resp.json()["child_count"] == 1
    assert detail_resp.json()["children"][0]["task_brief"] == "workspace task"
