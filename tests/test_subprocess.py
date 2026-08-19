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
        while any(not job.done() for job in service.jobs.values()):
            await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
            await asyncio.sleep(0.01)

        sub_state = service.state(sub_id)
        assert sub_state["status"] == "completed"

        # 2. Execute pipeline workflow
        pipe_started = await service.start("workflows/deploy_pipeline.bpmn", None, {"env": "prod"})
        pipe_id = pipe_started["workflow_id"]
        while any(not job.done() for job in service.jobs.values()):
            await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
            await asyncio.sleep(0.01)

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
