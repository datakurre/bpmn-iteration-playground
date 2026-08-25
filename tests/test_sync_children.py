import asyncio

from graph_agent.persistence import WorkflowStore
from graph_agent.pi_client import PiResult
from graph_agent.sync_children import sync_children
from graph_agent.workflow_service import WorkflowService


class FakePi:
    async def run(self, prompt: str, cwd: str) -> PiResult:
        return PiResult(
            "success",
            {"status": "success", "summary": "complete", "findings": [], "artifacts": [], "next_action": "continue"},
            "result",
            [],
            "",
            0,
        )


def test_sync_children_no_op_for_unknown_workflow() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    sync_children(service, "does-not-exist")


def test_sync_children_syncs_existing_root() -> None:
    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), FakePi())
        state = await service.start("graph_agent/data/workflows/contract_review.bpmn", None, {"contract": "text"})
        await asyncio.gather(*service.jobs.values())
        sync_children(service, state["workflow_id"])

    asyncio.run(scenario())
