import asyncio

from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.workflow_service import WorkflowService


class FakePlanAndExecutePi:
    def __init__(self) -> None:
        self.calls = 0
        self.sessions: list[str | None] = []

    async def run(
        self,
        prompt: str,
        cwd: str,
        session_id: str | None = None,
        fork: bool = False,
        **kwargs,
    ) -> PiResult:
        self.calls += 1
        self.sessions.append(session_id)
        if self.calls == 1:
            return PiResult(
                "success",
                {
                    "status": "success",
                    "summary": "Implementation plan formulated",
                    "plan": "1. Set up schemas\n2. Implement logic\n3. Run tests",
                    "findings": ["Clarification needed on timeout threshold"],
                    "artifacts": ["plan.md"],
                    "next_action": "review",
                },
                "Plan output text",
                [],
                "",
                0,
                session_id="session-turn-1-uuid",
            )
        else:
            return PiResult(
                "success",
                {
                    "status": "success",
                    "summary": "Implementation executed successfully with answers applied",
                    "findings": ["All tasks complete", "Tests passing"],
                    "artifacts": ["code.py", "test_code.py"],
                    "next_action": "verify",
                },
                "Execution output text",
                [],
                "",
                0,
                session_id="session-turn-2-uuid",
            )


def test_interactive_plan_and_execute_workflow() -> None:
    async def scenario() -> None:
        pi = FakePlanAndExecutePi()
        store = WorkflowStore(":memory:")
        service = WorkflowService(store, pi)

        # 1. Start the workflow -> executes Planning turn (non-interactive)
        started = await service.start(
            "workflows/plan_and_execute.bpmn",
            None,
            {"feature_request": "Build rate limiter"},
        )
        workflow_id = started["workflow_id"]

        async def _wait_jobs():
            while any(not job.done() for job in list(service.jobs.values())):
                pending = [job for job in list(service.jobs.values()) if not job.done()]
                if pending:
                    await asyncio.gather(*pending)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait_jobs(), timeout=5.0)

        # 2. Verify state is waiting for human input at Task_Review_Plan
        state = service.state(workflow_id)
        assert pi.calls == 1
        assert state["status"] == "waiting_human"
        assert state["pi_session_id"] == "session-turn-1-uuid"

        user_tasks = [t for t in state["tasks"] if t["state"] == "READY" and t.get("type") == "UserTask"]
        assert len(user_tasks) == 1
        review_task = user_tasks[0]
        assert review_task["bpmn_id"] == "Task_Review_Plan"

        # 3. Human completes review, answers questions, approves plan
        completed_step1 = await service.submit_task(
            workflow_id,
            review_task["id"],
            {
                "plan_approval": "approved",
                "human_answers": "Timeout threshold should be 5000ms.",
                "instructions": "Ensure tests use async test runner.",
            },
        )
        assert completed_step1["status"] in ("running", "waiting_human", "waiting_pi")

        await asyncio.wait_for(_wait_jobs(), timeout=5.0)

        # 4. Verify Pi executed step 2 with the session_id from step 1
        assert pi.calls == 2
        assert pi.sessions[1] == "session-turn-1-uuid"

        # 5. Verify human verification step is now READY
        state_step2 = service.state(workflow_id)
        assert state_step2["status"] == "waiting_human"
        verify_tasks = [t for t in state_step2["tasks"] if t["state"] == "READY" and t.get("type") == "UserTask"]
        assert len(verify_tasks) == 1
        verify_task = verify_tasks[0]
        assert verify_task["bpmn_id"] == "Task_Verify_Results"

        # 6. Human completes final signoff
        final_completed = await service.submit_task(
            workflow_id,
            verify_task["id"],
            {"signoff_decision": "accepted", "notes": "Verified implementation looks great."},
        )
        assert final_completed["status"] == "completed"

    asyncio.run(scenario())
