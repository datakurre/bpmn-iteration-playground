from fastapi.testclient import TestClient
from app.workflow_service import WorkflowService


def test_savepoint_detail_and_fork_endpoints(client: TestClient) -> None:
    start_resp = client.post(
        "/workflow/start",
        json={"bpmn_path": "workflows/contract_review.bpmn", "variables": {"contract": "Fork Test"}},
    )
    wf_id = start_resp.json()["workflow_id"]
    state_data = start_resp.json()
    save_points = state_data["save_points"]
    assert len(save_points) >= 1
    sp_id = save_points[0]["id"]

    # 1. Get savepoint detail
    detail_resp = client.get(f"/instance/{wf_id}/savepoint/{sp_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["id"] == sp_id
    assert detail["workflow_id"] == wf_id
    assert "data" in detail

    # 2. Get diagram XML
    diag_resp = client.get(f"/instance/{wf_id}/diagram")
    assert diag_resp.status_code == 200
    assert "application/xml" in diag_resp.headers["content-type"]
    assert "bpmn:definitions" in diag_resp.text

    # 3. Fork from savepoint
    fork_resp = client.post(
        f"/instance/{wf_id}/fork/{sp_id}",
        json={"variables": {"override_key": "override_value"}},
    )
    assert fork_resp.status_code == 200
    fork_data = fork_resp.json()
    assert fork_data["workflow_id"] != wf_id
    assert fork_data["data"]["override_key"] == "override_value"

    # 4. Error cases
    bad_sp_resp = client.post(
        f"/instance/{wf_id}/fork/nonexistent-savepoint-id",
        json={"variables": {}},
    )
    assert bad_sp_resp.status_code == 404

    bad_wf_resp = client.get("/instance/nonexistent-wf/diagram")
    assert bad_wf_resp.status_code == 404


def test_fork_from_completed_workflow_state(service: WorkflowService) -> None:
    import asyncio

    async def scenario() -> None:
        started = await service.start("workflows/contract_review.bpmn", None, {"contract": "Completed Fork Test"})
        wf_id = started["workflow_id"]
        sp_id = started["save_points"][0]["id"]

        # Wait for Pi task
        async def _wait():
            while any(not job.done() for job in list(service.jobs.values())):
                pending = [j for j in list(service.jobs.values()) if not j.done()]
                if pending:
                    await asyncio.gather(*pending)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait(), timeout=5.0)

        state = service.state(wf_id)
        ready_tasks = [t for t in state["tasks"] if t["state"] == "READY"]
        assert len(ready_tasks) >= 1
        user_task_id = ready_tasks[0]["id"]

        # Submit task to transition workflow to completed
        completed = await service.submit_task(wf_id, user_task_id, {"decision": "approved"})
        assert completed["status"] == "completed"

        # Fork from savepoint of the completed instance
        forked = await service.fork(wf_id, sp_id, {"fork_var": "val"})
        assert forked["workflow_id"] != wf_id
        assert forked["forked_from"] == wf_id
        assert forked["data"]["fork_var"] == "val"

    asyncio.run(scenario())

