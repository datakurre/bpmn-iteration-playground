import asyncio
from app.engine import WorkflowRunner
from app.persistence import WorkflowStore
from app.workflow_service import WorkflowService


def test_orphan_recovery_on_startup() -> None:
    async def scenario() -> None:
        store = WorkflowStore(":memory:")
        runner = WorkflowRunner()
        workflow, pid = runner.load_workflow("workflows/contract_review.bpmn")
        record = runner.record(
            "orphaned-wf-1",
            workflow,
            "workflows/contract_review.bpmn",
            pid,
            "waiting_pi",
            jobs={"task-1": {"status": "running"}},
            save_points=[],
            events=[],
        )
        store.save("orphaned-wf-1", record)

        service = WorkflowService(store)
        assert service.state("orphaned-wf-1")["status"] == "waiting_pi"

        recovered = await service.recover_orphaned_workflows()
        assert recovered == 1

        updated_state = service.state("orphaned-wf-1")
        assert updated_state["status"] == "failed"
        assert "orphaned workflow" in updated_state["failure_reason"].lower()

    asyncio.run(scenario())
