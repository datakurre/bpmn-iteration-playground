from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from graph_agent.adapters.mock_adapter import MockAdapter
from graph_agent.api.server import create_app
from graph_agent.models import ExtendNodeRequest, ExtendRequest
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService
from tests.bpmn_helpers import linear_bpmn


def _write_bpmn(tmp_path: Path, name: str, xml: str) -> str:
    path = tmp_path / name
    path.write_text(xml, encoding="utf-8")
    return str(path)


@pytest.mark.anyio
async def test_extend_inserts_and_migrates(tmp_path: Path) -> None:
    """POST /instance/{id}/extend inserts nodes and workflow advances through them."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        service.registry.bind("mock", MockAdapter())

        # Start workflow: Start -> UserTask_Prompt -> End
        v1_xml = linear_bpmn("Process_1", [("UserTask_Prompt", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        # Extend: insert a ServiceTask after UserTask_Prompt
        result = await service.extend_graph(
            wf_id,
            ExtendRequest(
                after="UserTask_Prompt",
                nodes=[
                    ExtendNodeRequest(
                        bpmn_id="Task_Plan",
                        name="Plan",
                        element_type="serviceTask",
                        properties={"harness_type": "mock"},
                    )
                ],
            ),
        )
        assert "Task_Plan" in result["inserted_nodes"]

        # Complete UserTask_Prompt
        task_prompt = next(t for t in instance["tasks"] if t["bpmn_id"] == "UserTask_Prompt")
        await service.submit_task(wf_id, task_prompt["id"], {"goal": "test goal"})

        # Wait for background job to finish executing Task_Plan
        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        # Task_Plan should have been executed by MockAdapter and completed
        state = service.state(wf_id)
        task_plan_states = [t["state"] for t in state["tasks"] if t["bpmn_id"] == "Task_Plan"]
        assert len(task_plan_states) == 1
        assert state["status"] == "completed"
    finally:
        store.close()


@pytest.mark.anyio
async def test_extend_with_camunda_extensions(tmp_path: Path) -> None:
    """Extended nodes have working Camunda extensions (inputs/outputs)."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock_output = {
            "status": "success",
            "summary": "Generated architecture plan",
            "findings": ["Finding 1"],
            "artifacts": [],
            "next_action": "continue",
        }
        service.registry.bind("mock", MockAdapter(output=mock_output))

        v1_xml = linear_bpmn("Process_1", [("UserTask_Prompt", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        await service.extend_graph(
            wf_id,
            ExtendRequest(
                after="UserTask_Prompt",
                nodes=[
                    ExtendNodeRequest(
                        bpmn_id="Task_Plan",
                        name="Plan",
                        element_type="serviceTask",
                        properties={"harness_type": "mock"},
                        input_params={"goal": "${user_goal}"},
                        output_params={
                            "plan_status": "${status}",
                            "plan_summary": "${summary}",
                        },
                    )
                ],
            ),
        )

        # Complete UserTask_Prompt providing user_goal
        task_prompt = next(t for t in instance["tasks"] if t["bpmn_id"] == "UserTask_Prompt")
        await service.submit_task(
            wf_id,
            task_prompt["id"],
            {"user_goal": "Build bootstrap loop"},
        )

        # Wait for mock agent to run
        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        # Check that output parameter was published to workflow data
        state = service.state(wf_id)
        assert state["data"].get("plan_status") == "success"
        assert state["data"].get("plan_summary") == "Generated architecture plan"
    finally:
        store.close()


@pytest.mark.anyio
async def test_extend_after_nonexistent_returns_400(tmp_path: Path) -> None:
    """POST with an 'after' node that doesn't exist returns 400."""
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
            resp = client.post(
                f"/instance/{wf_id}/extend",
                json={
                    "after": "Nonexistent_Node",
                    "nodes": [
                        {
                            "bpmn_id": "Task_New",
                            "name": "New",
                            "element_type": "serviceTask",
                        }
                    ],
                },
            )
            assert resp.status_code == 400
            assert "not found" in resp.json()["detail"]
    finally:
        store.close()


@pytest.mark.anyio
async def test_extend_while_running_returns_409(tmp_path: Path) -> None:
    """POST while an agent turn is executing returns 409."""
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
            service.store.update(wf_id, status="running")
            resp = client.post(
                f"/instance/{wf_id}/extend",
                json={
                    "after": "UserTask_1",
                    "nodes": [
                        {
                            "bpmn_id": "Task_New",
                            "name": "New",
                            "element_type": "serviceTask",
                        }
                    ],
                },
            )
            assert resp.status_code == 409
            assert "mid-execution" in resp.json()["detail"]
    finally:
        store.close()


@pytest.mark.anyio
async def test_extend_creates_savepoint(tmp_path: Path) -> None:
    """Graph extension creates a 'spec_replaced' savepoint."""
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
            resp = client.post(
                f"/instance/{wf_id}/extend",
                json={
                    "after": "UserTask_1",
                    "nodes": [
                        {
                            "bpmn_id": "Task_New",
                            "name": "New",
                            "element_type": "serviceTask",
                        }
                    ],
                },
            )
            assert resp.status_code == 200

            state_resp = client.get(f"/instance/{wf_id}/state")
            sp_data = state_resp.json()["save_points"]
            assert any(sp.get("phase") == "spec_replaced" for sp in sp_data)
    finally:
        store.close()


@pytest.mark.anyio
async def test_extend_end_to_end_with_mock_adapter(tmp_path: Path) -> None:
    """Full loop: start -> prompt -> extend -> complete prompt -> agent runs -> review -> end."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        service.registry.bind("mock", MockAdapter())

        # 1. Start with minimal BPMN: Start -> UserTask_Prompt -> End
        v1_xml = linear_bpmn("Process_1", [("UserTask_Prompt", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "v1.bpmn", v1_xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        # 2. Extend: insert mock agent task + review task
        extend_res = await service.extend_graph(
            wf_id,
            ExtendRequest(
                after="UserTask_Prompt",
                nodes=[
                    ExtendNodeRequest(
                        bpmn_id="Task_Agent",
                        name="Agent Task",
                        element_type="serviceTask",
                        properties={"harness_type": "mock"},
                    ),
                    ExtendNodeRequest(
                        bpmn_id="Task_Review",
                        name="Human Review",
                        element_type="userTask",
                    ),
                ],
            ),
        )
        assert "Task_Agent" in extend_res["inserted_nodes"]
        assert "Task_Review" in extend_res["inserted_nodes"]

        # 3. Complete UserTask_Prompt with goal
        prompt_task = next(t for t in instance["tasks"] if t["bpmn_id"] == "UserTask_Prompt")
        await service.submit_task(
            wf_id,
            prompt_task["id"],
            {"goal": "Autonomous iteration"},
        )

        # Wait for mock agent task to run
        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        # 4 & 5. Agent ran and completed, so workflow is waiting at Task_Review
        state = service.state(wf_id)
        assert state["status"] == "waiting_human"
        review_task = next(t for t in state["tasks"] if t["bpmn_id"] == "Task_Review")
        assert review_task["state"] == "READY"

        # 6. Complete review
        await service.submit_task(
            wf_id,
            review_task["id"],
            {"approved": True},
        )

        # 7. Workflow completes
        final_state = service.state(wf_id)
        assert final_state["status"] == "completed"
    finally:
        store.close()
