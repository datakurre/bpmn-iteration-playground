from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from SpiffWorkflow.task import TaskState

from graph_agent.adapters.mock_adapter import MockAdapter
from graph_agent.models import ExtendNodeRequest, ExtendRequest
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService
from tests.bpmn_helpers import linear_bpmn


def _write_bpmn(tmp_path: Path, name: str, xml: str) -> str:
    path = tmp_path / name
    path.write_text(xml, encoding="utf-8")
    return str(path)


@pytest.mark.anyio
async def test_resume_waiting_human_after_restart(tmp_path: Path) -> None:
    """An instance waiting at a user task is unaffected by restart recovery."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        xml = linear_bpmn("Process_1", [("UserTask_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "wf.bpmn", xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]
        assert instance["status"] == "waiting_human"

        # Simulate daemon restart: create new WorkflowService with same store
        new_service = WorkflowService(store)
        recovered = await new_service.recover_orphaned_workflows()
        assert recovered == 0

        # Instance should still be waiting_human
        state = new_service.state(wf_id)
        assert state["status"] == "waiting_human"

        # User task can still be submitted and completed
        task = next(t for t in state["tasks"] if t["bpmn_id"] == "UserTask_1")
        await new_service.submit_task(wf_id, task["id"], {"approved": True})
        final_state = new_service.state(wf_id)
        assert final_state["status"] == "completed"
    finally:
        store.close()


@pytest.mark.anyio
async def test_resume_dispatches_ready_tasks(tmp_path: Path) -> None:
    """After restart, instances with READY agent tasks are re-dispatched."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter()
        service.registry.bind("mock", mock)

        xml = linear_bpmn("Process_1", [("Task_A", "serviceTask", {"harness_type": "mock"})])
        bpmn_file = _write_bpmn(tmp_path, "wf.bpmn", xml)

        # Start instance but don't await jobs (simulate daemon being stopped right after start)
        wf_id, workflow, res_pid = service.runner.start(bpmn_file, None, {})
        record = service.runner.record(wf_id, workflow, bpmn_file, res_pid, "waiting_pi", jobs={}, save_points=[], events=[])
        service.store.save(wf_id, record)

        # Simulate restart: create new service and run recovery + resume
        new_service = WorkflowService(store)
        new_service.registry.bind("mock", mock)

        await new_service.resume_pending_workflows()
        if new_service.jobs:
            await asyncio.gather(*[j for j in new_service.jobs.values() if not j.done()])

        final_state = new_service.state(wf_id)
        assert final_state["status"] == "completed"
        assert mock.calls >= 1
    finally:
        store.close()


@pytest.mark.anyio
async def test_orphaned_running_marked_failed(tmp_path: Path) -> None:
    """An instance that was mid-agent-turn is marked failed on restart."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        xml = linear_bpmn("Process_1", [("Task_A", "serviceTask", {"harness_type": "mock"})])
        bpmn_file = _write_bpmn(tmp_path, "wf.bpmn", xml)

        wf_id, workflow, res_pid = service.runner.start(bpmn_file, None, {})
        task_a = next(t for t in workflow.get_tasks() if t.task_spec.name == "Task_A")
        task_a.state = TaskState.STARTED

        record = service.runner.record(
            wf_id,
            workflow,
            bpmn_file,
            res_pid,
            "running",
            jobs={str(task_a.id): {"task_id": str(task_a.id), "status": "running", "attempts": 1, "generation": 1}},
            save_points=[],
            events=[],
        )
        service.store.save(wf_id, record)

        # Simulate restart
        new_service = WorkflowService(store)
        recovered = await new_service.recover_orphaned_workflows()
        assert recovered == 1

        state = new_service.state(wf_id)
        assert state["status"] == "failed"
        assert state.get("failure_reason") is not None
        assert state["jobs"][str(task_a.id)]["status"] == "failed"
    finally:
        store.close()


@pytest.mark.anyio
async def test_orphaned_running_retryable(tmp_path: Path) -> None:
    """A restart-failed instance can be retried."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter()
        service.registry.bind("mock", mock)

        xml = linear_bpmn("Process_1", [("Task_A", "serviceTask", {"harness_type": "mock"})])
        bpmn_file = _write_bpmn(tmp_path, "wf.bpmn", xml)

        wf_id, workflow, res_pid = service.runner.start(bpmn_file, None, {})
        task_a = next(t for t in workflow.get_tasks() if t.task_spec.name == "Task_A")
        task_a.state = TaskState.STARTED

        record = service.runner.record(
            wf_id,
            workflow,
            bpmn_file,
            res_pid,
            "running",
            jobs={str(task_a.id): {"task_id": str(task_a.id), "status": "running", "attempts": 1, "generation": 1}},
            save_points=[],
            events=[],
        )
        service.store.save(wf_id, record)

        # Restart and recover
        new_service = WorkflowService(store)
        new_service.registry.bind("mock", mock)
        await new_service.recover_orphaned_workflows()

        # Retry the failed task
        await new_service.retry_task(wf_id, str(task_a.id))
        if new_service.jobs:
            await asyncio.gather(*[j for j in new_service.jobs.values() if not j.done()])

        final_state = new_service.state(wf_id)
        assert final_state["status"] == "completed"
    finally:
        store.close()


@pytest.mark.anyio
async def test_completed_instances_not_resumed(tmp_path: Path) -> None:
    """Completed instances are not touched by resume."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        xml = linear_bpmn("Process_1", [("UserTask_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "wf.bpmn", xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]
        task = next(t for t in instance["tasks"] if t["bpmn_id"] == "UserTask_1")
        await service.submit_task(wf_id, task["id"], {})
        assert service.state(wf_id)["status"] == "completed"

        # Restart
        new_service = WorkflowService(store)
        recovered = await new_service.recover_orphaned_workflows()
        resumed = await new_service.resume_pending_workflows()
        assert recovered == 0
        assert resumed == 0
        assert new_service.state(wf_id)["status"] == "completed"
    finally:
        store.close()


@pytest.mark.anyio
async def test_list_active_returns_nonterminal(tmp_path: Path) -> None:
    """list_active() returns only non-completed, non-cancelled instances."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        xml = linear_bpmn("Process_1", [("UserTask_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "wf.bpmn", xml)

        # 1. Active instance (waiting_human)
        i1 = await service.start(bpmn_file, {})
        wf1 = i1["workflow_id"]

        # 2. Completed instance
        i2 = await service.start(bpmn_file, {})
        wf2 = i2["workflow_id"]
        task2 = next(t for t in i2["tasks"] if t["bpmn_id"] == "UserTask_1")
        await service.submit_task(wf2, task2["id"], {})

        # 3. Cancelled instance
        i3 = await service.start(bpmn_file, {})
        wf3 = i3["workflow_id"]
        await service.cancel(wf3)

        active = store.list_active()
        assert wf1 in active
        assert wf2 not in active
        assert wf3 not in active
    finally:
        store.close()


@pytest.mark.anyio
async def test_multiple_restarts_idempotent(tmp_path: Path) -> None:
    """Running recovery and resume multiple times doesn't corrupt state."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        xml = linear_bpmn("Process_1", [("UserTask_1", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "wf.bpmn", xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        for _ in range(3):
            svc = WorkflowService(store)
            rec = await svc.recover_orphaned_workflows()
            res = await svc.resume_pending_workflows()
            assert rec == 0
            assert res == 0
            assert svc.state(wf_id)["status"] == "waiting_human"
    finally:
        store.close()


@pytest.mark.anyio
async def test_bootstrap_survives_restart(tmp_path: Path) -> None:
    """A bootstrap loop instance survives restart and resumes at its prompt."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter()
        service.registry.bind("mock", mock)

        # Start minimal: Start -> UserTask_Prompt -> End
        xml = linear_bpmn("Process_1", [("UserTask_Prompt", "userTask", {})])
        bpmn_file = _write_bpmn(tmp_path, "bootstrap.bpmn", xml)
        instance = await service.start(bpmn_file, {})
        wf_id = instance["workflow_id"]

        # Extend with Agent Task + Review Task
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
                    ),
                    ExtendNodeRequest(
                        bpmn_id="Task_Review",
                        name="Review",
                        element_type="userTask",
                    ),
                ],
            ),
        )

        # Simulate restart
        new_service = WorkflowService(store)
        new_service.registry.bind("mock", mock)
        await new_service.recover_orphaned_workflows()
        await new_service.resume_pending_workflows()

        # Should still be waiting at UserTask_Prompt
        state = new_service.state(wf_id)
        assert state["status"] == "waiting_human"
        prompt_task = next(t for t in state["tasks"] if t["bpmn_id"] == "UserTask_Prompt")

        # Submit prompt
        await new_service.submit_task(wf_id, prompt_task["id"], {"goal": "Resume test"})
        if new_service.jobs:
            await asyncio.gather(*[j for j in new_service.jobs.values() if not j.done()])

        # Should now be at Task_Review
        state2 = new_service.state(wf_id)
        assert state2["status"] == "waiting_human"
        review_task = next(t for t in state2["tasks"] if t["bpmn_id"] == "Task_Review")
        assert review_task["state"] == "READY"

        # Complete review
        await new_service.submit_task(wf_id, review_task["id"], {"approved": True})
        final_state = new_service.state(wf_id)
        assert final_state["status"] == "completed"
    finally:
        store.close()
