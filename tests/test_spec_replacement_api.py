from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from graph_agent.api.server import create_app
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService
from tests.bpmn_helpers import linear_bpmn


def _write_bpmn(tmp_path: Path, name: str, xml: str) -> str:
    path = tmp_path / name
    path.write_text(xml, encoding="utf-8")
    return str(path)


@pytest.mark.anyio
async def test_put_spec_replaces_and_saves(tmp_path: Path) -> None:
    """PUT /instance/{id}/spec with valid BPMN replaces the spec and persists it."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        app = create_app(service)

        # Start workflow with v1 (Start -> UserTask_1 -> End)
        v1_xml = linear_bpmn("Process_1", [("UserTask_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        # PUT v2 (Start -> UserTask_1 -> ServiceTask_2 -> End)
        v2_xml = linear_bpmn(
            "Process_1",
            [
                ("UserTask_1", "userTask", {}),
                ("ServiceTask_2", "serviceTask", {"harness_type": "pi_agent", "agent_role": "executor"}),
            ],
        )

        with TestClient(app) as client:
            resp = client.put(
                f"/instance/{wf_id}/spec",
                content=v2_xml,
                headers={"Content-Type": "application/xml"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["workflow_id"] == wf_id
            assert "warnings" in data

            # Verify GET /instance/{id}/spec returns the updated XML
            get_resp = client.get(f"/instance/{wf_id}/spec")
            assert get_resp.status_code == 200
            assert "ServiceTask_2" in get_resp.text
    finally:
        store.close()


@pytest.mark.anyio
async def test_put_spec_invalid_xml_returns_400(tmp_path: Path) -> None:
    """PUT /instance/{id}/spec with invalid XML returns 400."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        app = create_app(service)

        v1_xml = linear_bpmn("Process_1", [("UserTask_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        with TestClient(app) as client:
            resp = client.put(
                f"/instance/{wf_id}/spec",
                content="<broken-xml",
                headers={"Content-Type": "application/xml"},
            )
            assert resp.status_code == 400
            assert "detail" in resp.json()
    finally:
        store.close()


@pytest.mark.anyio
async def test_put_spec_removes_active_task_returns_409(tmp_path: Path) -> None:
    """PUT with BPMN that removes the current waiting task returns 409."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        app = create_app(service)

        # Start workflow with Task_A -> Task_B
        v1_xml = linear_bpmn("Process_1", [("Task_A", "userTask", {}) , ("Task_B", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        # Waiting at Task_A. PUT XML that removes Task_A
        v2_xml = linear_bpmn("Process_1", [("Task_B", "userTask", {})])

        with TestClient(app) as client:
            resp = client.put(
                f"/instance/{wf_id}/spec",
                content=v2_xml,
                headers={"Content-Type": "application/xml"},
            )
            assert resp.status_code == 409
            assert "Task_A" in resp.json()["detail"]
    finally:
        store.close()


@pytest.mark.anyio
async def test_put_spec_during_running_returns_409(tmp_path: Path) -> None:
    """PUT while workflow status is 'running' returns 409."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        app = create_app(service)

        v1_xml = linear_bpmn("Process_1", [("Task_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        with TestClient(app) as client:
            # Set status to running while test client is running
            service.store.update(wf_id, status="running")

            resp = client.put(
                f"/instance/{wf_id}/spec",
                content=v1_xml,
                headers={"Content-Type": "application/xml"},
            )
            assert resp.status_code == 409
            assert "mid-execution" in resp.json()["detail"]
    finally:
        store.close()


@pytest.mark.anyio
async def test_post_validate_returns_dry_run(tmp_path: Path) -> None:
    """POST /instance/{id}/spec/validate returns dry-run analysis without modifying workflow."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        app = create_app(service)

        v1_xml = linear_bpmn("Process_1", [("Task_A", "userTask", {}), ("Task_B", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        # Advance Task_A using its runtime task UUID
        task_a = next(t for t in instance["tasks"] if t["name"] == "Task_A")
        await service.submit_task(wf_id, task_a["id"], {})

        # Valid dry-run: v2 adds Task_C
        v2_xml = linear_bpmn(
            "Process_1",
            [("Task_B", "userTask", {}), ("Task_C", "userTask", {})],
        )

        with TestClient(app) as client:
            resp = client.post(
                f"/instance/{wf_id}/spec/validate",
                content=v2_xml,
                headers={"Content-Type": "application/xml"},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["valid"] is True
            assert "Task_B" in data["migrated_tasks"]
            assert "Task_C" in data["new_tasks"]
            assert "Task_A" in data["removed_tasks"]

            # Verify workflow spec was NOT modified by validate
            get_resp = client.get(f"/instance/{wf_id}/spec")
            assert "Task_C" not in get_resp.text
    finally:
        store.close()


@pytest.mark.anyio
async def test_put_spec_creates_savepoint(tmp_path: Path) -> None:
    """After spec replacement, a 'spec_replaced' savepoint exists on the record."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        app = create_app(service)

        v1_xml = linear_bpmn("Process_1", [("Task_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        v2_xml = linear_bpmn("Process_1", [("Task_1", "userTask", {}), ("Task_2", "userTask", {})])

        with TestClient(app) as client:
            resp = client.put(
                f"/instance/{wf_id}/spec",
                content=v2_xml,
                headers={"Content-Type": "application/xml"},
            )
            assert resp.status_code == 200

            # Check savepoints from instance state
            state_resp = client.get(f"/instance/{wf_id}/state")
            assert state_resp.status_code == 200
            sp_data = state_resp.json()["save_points"]
            assert any(sp.get("phase") == "spec_replaced" for sp in sp_data)
    finally:
        store.close()
