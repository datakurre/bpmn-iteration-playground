"""End-to-end tests for the interactive session loop, planner verification, dynamic migration, and diff API."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from graph_agent.adapters.mock_adapter import MockAdapter
from graph_agent.api.server import create_app
from graph_agent.bpmn_utils import validate_bpmn
from graph_agent.persistence import WorkflowStore
from graph_agent.registry import BUNDLED_WORKFLOWS_DIR
from graph_agent.workflow_service import WorkflowService


def test_interactive_session_template_valid() -> None:
    """Validate that interactive_session.bpmn is syntactically and structurally valid."""
    bpmn_path = BUNDLED_WORKFLOWS_DIR / "interactive_session.bpmn"
    assert bpmn_path.is_file()
    xml = bpmn_path.read_text(encoding="utf-8")
    val_res = validate_bpmn(xml)
    assert val_res.valid, f"Validation failed: {val_res.errors}"
    assert "interactive_session" in val_res.process_ids
    assert "UserTask_IS_Prompt" in val_res.task_ids
    assert "Task_IS_PlanGraph" in val_res.task_ids
    assert "Task_IS_LintBPMN" in val_res.task_ids
    assert "ServiceTask_IS_ApplyExtension" in val_res.task_ids
    assert "UserTask_IS_Review" in val_res.task_ids


@pytest.mark.anyio
async def test_interactive_session_lifecycle(tmp_path: Path) -> None:
    """Test the full interactive session lifecycle: Prompt -> Plan & Lint -> Splicing -> Review."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        plan_extension_spec = {
            "after": "ServiceTask_IS_ApplyExtension",
            "nodes": [
                {
                    "bpmn_id": "Task_ImplementCode",
                    "name": "Implement Code Changes",
                    "element_type": "serviceTask",
                    "properties": {"harness_type": "mock", "agent_role": "coder"},
                    "input_params": {"user_prompt": "${user_prompt}"},
                    "output_params": {"status": "${status}", "summary": "${summary}"},
                }
            ],
        }

        mock_planner_output = {
            "status": "success",
            "summary": "Plan formulated and verified with bpmnlint",
            "findings": [plan_extension_spec],
            "artifacts": [],
            "next_action": "continue",
        }

        service.registry.bind("pi_agent", MockAdapter(output=mock_planner_output))
        service.registry.bind("mock", MockAdapter(output={"status": "success", "summary": "Code written"}))

        bpmn_path = str(BUNDLED_WORKFLOWS_DIR / "interactive_session.bpmn")
        instance = await service.start(bpmn_path, {})
        wf_id = instance["workflow_id"]

        # Initial state should be waiting at UserTask_IS_Prompt
        assert instance["status"] == "waiting_human"
        tasks = instance["tasks"]
        prompt_task = next(t for t in tasks if t["bpmn_id"] == "UserTask_IS_Prompt")
        assert prompt_task["state"] == "READY"

        # Submit prompt
        await service.submit_task(wf_id, prompt_task["id"], {"user_prompt": "Create greeting module", "context": ""})

        # Allow chained background planner, validator, splicing, and execution turns to run
        for _ in range(25):
            pending = [j for j in service.jobs.values() if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.05)
            state = service.state(wf_id)
            if state["status"] in ("waiting_human", "completed") and any(
                "Review" in t.get("name", "") and t.get("state") == "READY" for t in state["tasks"]
            ):
                break

        # Workflow should now have progressed past planner and reached UserTask_IS_Review
        state = service.state(wf_id)
        assert state["status"] in ("waiting_human", "completed", "running")

        # Find review task
        review_tasks = [t for t in state["tasks"] if "Review" in t.get("name", "") and t.get("state") == "READY"]
        assert len(review_tasks) > 0, f"Expected Review task to be READY, current tasks: {state['tasks']}"
        rev_task = review_tasks[0]
        await service.submit_task(wf_id, rev_task["id"], {"review_decision": "approve", "review_feedback": ""})

        for _ in range(10):
            pending = [j for j in service.jobs.values() if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.02)

        final_state = service.state(wf_id)
        assert final_state["status"] == "completed"

    finally:
        store.close()


def test_diff_api_endpoint(tmp_path: Path) -> None:
    """Test GET /instance/{id}/diff endpoint returns expected schema."""
    from graph_agent.agents_root import Workspace
    ws = Workspace.discover(tmp_path)
    app = create_app(workspace=ws)
    client = TestClient(app)

    # Start a run
    bpmn_path = str(BUNDLED_WORKFLOWS_DIR / "interactive_session.bpmn")
    resp = client.post("/workflow/start", json={"bpmn_path": bpmn_path, "variables": {}})
    assert resp.status_code == 200
    wf_id = resp.json()["workflow_id"]

    # Call diff endpoint
    diff_resp = client.get(f"/instance/{wf_id}/diff")
    assert diff_resp.status_code == 200
    diff_data = diff_resp.json()
    assert "diff" in diff_data
    assert "files_changed" in diff_data


def test_tui_stepper_widget() -> None:
    """Test BpmnStepper rendering with various task states."""
    from graph_agent.tui.widgets.bpmn_stepper import BpmnStepper

    stepper = BpmnStepper()
    stepper.update_state({
        "workflow_id": "test12345",
        "status": "running",
        "tasks": [
            {"id": "t1", "name": "Prompt User", "state": "COMPLETED"},
            {"id": "t2", "name": "Formulate Execution Plan & Graph", "state": "STARTED"},
        ],
    })
    rendered = stepper.render()
    assert rendered is not None


def test_tui_diff_view_widget() -> None:
    """Test DiffViewWidget with sample diff text."""
    from graph_agent.tui.widgets.diff_view import DiffViewWidget

    sample_diff = """--- a/file.py\n+++ b/file.py\n@@ -1,2 +1,3 @@\n def hello():\n-    pass\n+    return "world"\n"""
    widget = DiffViewWidget(diff_text=sample_diff)
    rendered = widget.render()
    assert rendered is not None
