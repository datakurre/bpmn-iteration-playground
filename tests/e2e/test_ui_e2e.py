import os

import pytest
from fastapi.testclient import TestClient

from bpmn_agent.adapters.mock_adapter import MockAdapter
from bpmn_agent.api.server import create_app
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.workflow_service import WorkflowService


@pytest.fixture
def e2e_client():
    store = WorkflowStore(":memory:")
    mock = MockAdapter(status="success", output={
        "status": "success",
        "summary": "E2E review completed successfully",
        "findings": ["finding-1", "finding-2"],
        "artifacts": ["document.md"],
        "next_action": "continue",
    })
    service = WorkflowService(store, mock)
    app = create_app(service=service)
    with TestClient(app) as client:
        yield client
    store.close()


def test_e2e_full_workflow_lifecycle(e2e_client: TestClient) -> None:
    # 1. Access Dashboard
    dash_resp = e2e_client.get("/")
    assert dash_resp.status_code == 200
    assert "Workflow Studio" in dash_resp.text

    # 2. Access Editor
    editor_resp = e2e_client.get("/editor")
    assert editor_resp.status_code == 200
    assert "BPMN Workflow Editor" in editor_resp.text

    # 3. Access History
    hist_resp = e2e_client.get("/history")
    assert hist_resp.status_code == 200
    assert "Execution History" in hist_resp.text

    # 4. Access Admin
    admin_resp = e2e_client.get("/admin")
    assert admin_resp.status_code == 200
    assert "Database & Instance Management" in admin_resp.text

    # 5. Start a workflow
    start_resp = e2e_client.post(
        "/workflow/start",
        json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {"contract": "E2E Agreement"}},
    )
    assert start_resp.status_code == 200
    wf_id = start_resp.json()["workflow_id"]

    # 6. Verify instance page renders
    inst_resp = e2e_client.get(f"/instance/{wf_id}")
    assert inst_resp.status_code == 200
    assert "Persisted Instance View" in inst_resp.text
    assert wf_id in inst_resp.text

    # 7. Check instance state and wait for user task to become READY
    import time
    task_id = None
    for _ in range(50):
        state_resp = e2e_client.get(f"/instance/{wf_id}/state")
        assert state_resp.status_code == 200
        state_data = state_resp.json()
        ready_tasks = [t for t in state_data.get("tasks", []) if t.get("state") == "READY"]
        if ready_tasks:
            task_id = ready_tasks[0]["id"]
            break
        time.sleep(0.05)

    assert task_id is not None, f"No READY task found in state: {state_data}"

    # 8. Load task form schema
    form_resp = e2e_client.get(f"/instance/{wf_id}/form/{task_id}")
    assert form_resp.status_code == 200
    assert "components" in form_resp.json()

    # 9. Submit task
    submit_resp = e2e_client.post(
        f"/instance/{wf_id}/submit-task/{task_id}",
        json={"variables": {"decision": "approved", "notes": "Approved in E2E"}},
    )
    assert submit_resp.status_code == 200
    assert submit_resp.json()["status"] == "completed"

    # 10. The instance state must carry the manifest the Workspace Files panel binds to.
    #     It renders from `state.workspace_metadata`; when that key was missing the panel
    #     stayed hidden forever while /workspace/files still answered correctly, so assert
    #     both halves agree. scripts/verify_workspace_files_ui.py covers the rendering.
    ws_state = e2e_client.get(f"/instance/{wf_id}/state").json()
    ws_meta = ws_state.get("workspace_metadata")
    assert ws_meta is not None, "state() must expose workspace_metadata for the instance UI"
    assert e2e_client.get(f"/instance/{wf_id}/workspace/files").json() == ws_meta

    # 11. Check history detail page
    detail_resp = e2e_client.get(f"/history/{wf_id}")
    assert detail_resp.status_code == 200
    assert "Save Point Payload" in detail_resp.text


def test_playwright_scripts_syntax_and_structure() -> None:
    # Verify that verify scripts in scripts/ are valid python files
    for script_name in [
        "verify_instance_ui.py",
        "verify_history_ui.py",
        "verify_savepoints.py",
        "verify_retry_ui.py",
        "verify_savepoint_purge.py",
        "verify_workspace_files_ui.py",
    ]:
        script_path = os.path.join("scripts", script_name)
        assert os.path.exists(script_path), f"{script_path} must exist"
        with open(script_path, encoding="utf-8") as f:
            content = f.read()
            assert "playwright" in content
