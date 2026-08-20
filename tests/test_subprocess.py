import asyncio
from app.persistence import WorkflowStore
from app.pi_rpc import PiResult
from app.workflow_service import WorkflowService


class SubprocessFakePi:
    async def run(self, prompt: str, cwd: str) -> PiResult:
        return PiResult(
            "success",
            {
                "status": "success",
                "summary": "Subprocess review completed",
                "findings": ["finding-sub-1"],
                "artifacts": [],
                "next_action": "continue",
            },
            "Subprocess result",
            [],
            "",
            0,
        )


def test_chained_workflow_execution() -> None:
    async def scenario() -> None:
        store = WorkflowStore(":memory:")
        service = WorkflowService(store, SubprocessFakePi())

        # 1. Execute subprocess directly
        sub_started = await service.start("workflows/code_review_subprocess.bpmn", None, {"target": "auth.py"})
        sub_id = sub_started["workflow_id"]
        async def _wait_sub():
            while any(not job.done() for job in list(service.jobs.values())):
                pending = [job for job in list(service.jobs.values()) if not job.done()]
                if pending:
                    await asyncio.gather(*pending)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait_sub(), timeout=5.0)

        sub_state = service.state(sub_id)
        assert sub_state["status"] == "completed"

        # 2. Execute pipeline workflow
        pipe_started = await service.start("workflows/deploy_pipeline.bpmn", None, {"env": "prod"})
        pipe_id = pipe_started["workflow_id"]
        async def _wait_pipe():
            while any(not job.done() for job in list(service.jobs.values())):
                pending = [job for job in list(service.jobs.values()) if not job.done()]
                if pending:
                    await asyncio.gather(*pending)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait_pipe(), timeout=5.0)

        pipe_state = service.state(pipe_id)
        assert pipe_state["status"] == "waiting_human"

        # Complete human confirmation
        user_tasks = [t for t in pipe_state["tasks"] if t["state"] == "READY" and t.get("type") == "UserTask"]
        assert len(user_tasks) == 1
        complete_resp = await service.submit_task(
            pipe_id,
            user_tasks[0]["id"],
            {"deploy_decision": "approved", "target_environment": "production"},
        )
        assert complete_resp["status"] == "completed"

    asyncio.run(scenario())


def test_sync_children_cycle_detection() -> None:
    from unittest.mock import MagicMock
    from app.sync_children import sync_children

    service = MagicMock()
    # Mock circular child workflow reference
    parent_wf = MagicMock()
    child_wf = MagicMock()

    task1 = MagicMock()
    task1.task_spec = MagicMock()
    type(task1.task_spec).__name__ = "CallActivity"
    task1.id = "task-1"
    task1.workflow = child_wf

    task2 = MagicMock()
    task2.task_spec = MagicMock()
    type(task2.task_spec).__name__ = "CallActivity"
    task2.id = "task-2"
    task2.workflow = parent_wf  # cycle back to parent_wf

    parent_wf.get_tasks.return_value = [task1]
    child_wf.get_tasks.return_value = [task2]
    parent_wf.data = {}
    child_wf.data = {}

    service.store.load.side_effect = lambda wid: {"workflow": parent_wf, "data": {}} if wid == "root-1" else None
    service.runner.record.return_value = {"workflow": child_wf, "data": {}}

    # Should complete without RecursionError
    sync_children(service, "root-1")


def test_fork_child_workflow_raises_explicit_error() -> None:
    import pytest

    async def scenario() -> None:
        store = WorkflowStore(":memory:")
        service = WorkflowService(store, SubprocessFakePi())

        # Create root and child records
        store.save("root-wf", {"parent_workflow_id": None, "save_points": [], "workflow": None})
        store.save("child-wf", {"parent_workflow_id": "root-wf", "save_points": [], "workflow": None})

        with pytest.raises(ValueError) as exc:
            await service.fork("child-wf", "sp-1")
        assert "Cannot fork child workflow" in str(exc.value)

    asyncio.run(scenario())


