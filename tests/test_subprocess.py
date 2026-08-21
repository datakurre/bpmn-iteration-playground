import asyncio

from app.persistence import WorkflowStore
from app.pi_client import PiResult
from app.workflow_service import WorkflowService


class SubprocessFakePi:
    async def run(self, prompt: str, cwd: str, **kwargs) -> PiResult:
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

        # Execute bug triage workflow
        bug_started = await service.start("workflows/bug_triage.bpmn", None, {"bug_report": "Memory leak in auth handler"})
        bug_id = bug_started["workflow_id"]
        async def _wait_jobs():
            while any(not job.done() for job in list(service.jobs.values())):
                pending = [job for job in list(service.jobs.values()) if not job.done()]
                if pending:
                    await asyncio.gather(*pending)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait_jobs(), timeout=5.0)

        bug_state = service.state(bug_id)
        assert bug_state["status"] == "waiting_human"

        # Complete human clarification
        user_tasks = [t for t in bug_state["tasks"] if t["state"] == "READY" and t.get("type") == "UserTask"]
        assert len(user_tasks) == 1
        complete_resp = await service.submit_task(
            bug_id,
            user_tasks[0]["id"],
            {"reproduction_notes": "Occurs on token refresh", "priority": "high", "proceed_with_fix": "yes"},
        )
        assert complete_resp["status"] in ("running", "waiting_human", "waiting_pi")

        await asyncio.wait_for(_wait_jobs(), timeout=5.0)
        verify_state = service.state(bug_id)
        assert verify_state["status"] == "waiting_human"

    asyncio.run(scenario())


async def _wait_jobs(service) -> None:
    while any(not job.done() for job in list(service.jobs.values())):
        pending = [job for job in list(service.jobs.values()) if not job.done()]
        if pending:
            await asyncio.gather(*pending)
        await asyncio.sleep(0.01)


def test_call_activity_runs_child_process_with_human_gate() -> None:
    """composed_delivery calls agent_review_cycle: an agent turn and a human gate
    inside the called process, then the parent graph resumes from its result."""

    async def scenario() -> None:
        store = WorkflowStore(":memory:")
        service = WorkflowService(store, SubprocessFakePi())

        started = await service.start(
            "workflows/composed_delivery.bpmn", None, {"subject": "the API surface"}
        )
        workflow_id = started["workflow_id"]
        await asyncio.wait_for(_wait_jobs(service), timeout=5.0)

        state = service.state(workflow_id)
        assert state["status"] == "waiting_human"

        # The gate lives inside the called subprocess but surfaces on the parent instance
        signoff = next(t for t in state["tasks"] if t["bpmn_id"] == "Task_Cycle_Signoff")
        assert signoff["state"] == "READY"

        # camunda:formData is loaded for task specs inside the called process
        form = service.form(workflow_id, signoff["id"])
        assert "cycle_decision" in [component["key"] for component in form["components"]]

        # Exactly one child record, back-referencing its parent
        children = [i for i in service.instances() if i["process_id"] == "agent_review_cycle"]
        assert len(children) == 1
        child_record = store.load(children[0]["workflow_id"])
        assert child_record is not None
        assert child_record["parent_workflow_id"] == workflow_id

        # Signing off in the child resumes the parent graph through its own agent turn
        await service.submit_task(
            workflow_id, signoff["id"], {"cycle_decision": "accepted", "cycle_notes": "ok"}
        )
        await asyncio.wait_for(_wait_jobs(service), timeout=5.0)

        final = service.state(workflow_id)
        assert final["status"] == "completed"
        assert final["data"]["delivery_status"] == "success"

        # Repeated syncs must not mint duplicate child records
        assert len([i for i in service.instances() if i["process_id"] == "agent_review_cycle"]) == 1

    asyncio.run(scenario())


def test_call_activity_rejected_review_skips_delivery() -> None:
    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), SubprocessFakePi())
        started = await service.start(
            "workflows/composed_delivery.bpmn", None, {"subject": "the API surface"}
        )
        workflow_id = started["workflow_id"]
        await asyncio.wait_for(_wait_jobs(service), timeout=5.0)

        signoff = next(
            t for t in service.state(workflow_id)["tasks"] if t["bpmn_id"] == "Task_Cycle_Signoff"
        )
        await service.submit_task(workflow_id, signoff["id"], {"cycle_decision": "rejected"})
        await asyncio.wait_for(_wait_jobs(service), timeout=5.0)

        final = service.state(workflow_id)
        assert final["status"] == "completed"
        assert "delivery_status" not in final["data"]
        assert not any(t["bpmn_id"] == "Task_Deliver" for t in final["tasks"])

    asyncio.run(scenario())


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
