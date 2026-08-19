import asyncio

from app.persistence import WorkflowStore
from app.pi_rpc import PiResult
from app.workflow_service import WorkflowService


class FakePi:
    calls = 0

    async def run(self, prompt: str, cwd: str) -> PiResult:
        self.calls += 1
        return PiResult(
            "success",
            {
                "status": "success",
                "summary": "complete",
                "findings": [],
                "artifacts": [],
                "next_action": "continue",
            },
            "result",
            [],
            "",
            0,
        )


def test_pi_task_persists_and_waits_for_human_task() -> None:
    async def scenario() -> None:
        pi = FakePi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        state = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        await asyncio.gather(*service.jobs.values())
        state = service.state(state["workflow_id"])
        assert state["status"] == "waiting_human"
        assert state["data"]["agent_status"] == "success"
        phases = [point["phase"] for point in state["save_points"]]
        assert phases == ["before_harness", "after_harness", "human_wait"]
        review_task = next(task for task in state["tasks"] if task["bpmn_id"] == "ServiceTask_Review")
        assert service.form(state["workflow_id"], review_task["id"])["fields"][0]["id"] == "decision"

        before = next(point for point in state["save_points"] if point["phase"] == "before_harness")
        before_fork = await service.fork(state["workflow_id"], before["id"])
        await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
        assert service.state(before_fork["workflow_id"])["status"] == "waiting_human"
        assert pi.calls == 2

        after = next(point for point in state["save_points"] if point["phase"] == "after_harness")
        after_fork = await service.fork(state["workflow_id"], after["id"])
        assert after_fork["status"] == "waiting_human"
        assert pi.calls == 2

        completed = await service.submit_task(
            state["workflow_id"], review_task["id"], {"decision": "approved"}
        )
        assert completed["status"] == "completed"
        assert completed["data"]["decision"] == "approved"

    asyncio.run(scenario())


def test_failed_pi_state_contains_failure_reason() -> None:
    class FailedPi:
        async def run(self, prompt: str, cwd: str) -> PiResult:
            return PiResult("failed", None, "", [], "model response was invalid", 1)

    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), FailedPi())
        started = await service.start("workflows/contract_review.bpmn", None, {})
        await asyncio.gather(*service.jobs.values())
        state = service.state(started["workflow_id"])
        assert state["status"] == "failed"
        assert state["failure_reason"] == "model response was invalid"
        assert state["data"]["failure_reason"] == "model response was invalid"
        assert state["jobs"][next(iter(state["jobs"]))]["failure_reason"] == "model response was invalid"

    asyncio.run(scenario())


def test_failed_pi_task_retries_on_explicit_request() -> None:
    class FlakyPi:
        calls = 0

        async def run(self, prompt: str, cwd: str) -> PiResult:
            self.calls += 1
            if self.calls == 1:
                return PiResult("failed", None, "", [], "temporary provider error", 1)
            return await FakePi().run(prompt, cwd)

    async def scenario() -> None:
        pi = FlakyPi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        started = await service.start("workflows/contract_review.bpmn", None, {})
        await asyncio.gather(*service.jobs.values())
        state = service.state(started["workflow_id"])
        assert pi.calls == 1
        assert state["status"] == "failed"
        task_id = next(iter(state["jobs"]))
        retried = await service.retry_task(state["workflow_id"], task_id)
        await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
        state = service.state(retried["workflow_id"])
        assert pi.calls == 2
        assert state["status"] == "waiting_human"
        assert state["failure_reason"] is None
        assert state["jobs"][task_id]["attempts"] == 1
        assert "retry_requested" in [point["phase"] for point in state["save_points"]]

    asyncio.run(scenario())
