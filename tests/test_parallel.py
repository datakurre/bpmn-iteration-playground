import asyncio

from app.persistence import WorkflowStore
from app.pi_rpc import PiResult
from app.workflow_service import WorkflowService


class ParallelFakePi:
    def __init__(self) -> None:
        self.calls = 0
        self.called_tasks: list[str] = []

    async def run(self, prompt: str, cwd: str) -> PiResult:
        self.calls += 1
        return PiResult(
            "success",
            {
                "status": "success",
                "summary": f"Parallel agent run {self.calls}",
                "findings": [f"finding-{self.calls}"],
                "artifacts": [],
                "next_action": "continue",
            },
            f"Result {self.calls}",
            [],
            "",
            0,
        )


def test_parallel_gateway_execution() -> None:
    async def scenario() -> None:
        pi = ParallelFakePi()
        store = WorkflowStore(":memory:")
        service = WorkflowService(store, pi)

        started = await service.start("workflows/parallel_review.bpmn", None, {"repo": "test/repo"})
        workflow_id = started["workflow_id"]

        # Await both parallel agent executions
        while any(not job.done() for job in service.jobs.values()):
            await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
            await asyncio.sleep(0.01)

        state = service.state(workflow_id)
        assert pi.calls == 2
        assert state["status"] == "waiting_human"

        # Find the final review task
        user_tasks = [t for t in state["tasks"] if t["state"] == "READY" and t.get("type") == "UserTask"]
        assert len(user_tasks) == 1
        final_task = user_tasks[0]
        assert final_task["bpmn_id"] == "Task_FinalReview"

        # Submit final human review
        completed = await service.submit_task(
            workflow_id,
            final_task["id"],
            {"decision": "approved", "review_notes": "All checks passed in parallel"},
        )
        assert completed["status"] == "completed"
        assert completed["data"]["decision"] == "approved"

    asyncio.run(scenario())
