import asyncio

from graph_agent.api.server import create_app
from graph_agent.persistence import WorkflowStore
from graph_agent.pi_client import PiResult
from graph_agent.workflow_service import WorkflowService


class FakePi:
    async def run(self, prompt: str, cwd: str) -> PiResult:
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


def test_history_instances_and_savepoint_detail() -> None:
    async def scenario() -> None:
        pi = FakePi()
        store = WorkflowStore(":memory:")
        service = WorkflowService(store, pi)
        create_app(service)

        # 1. Check history instances when empty
        assert service.history_instances() == []

        # 2. Start a workflow and complete human task
        started = await service.start("graph_agent/data/workflows/agent_review_cycle.bpmn", None, {"subject": "text"})
        await asyncio.gather(*service.jobs.values())

        signoff_task = next(
            task for task in service.state(started["workflow_id"])["tasks"] if task["bpmn_id"] == "Task_Cycle_Signoff"
        )
        await service.submit_task(
            started["workflow_id"], signoff_task["id"], {"cycle_decision": "accepted", "cycle_notes": "ok"}
        )

        # 3. Verify history list
        items = service.history_instances()
        assert len(items) == 1
        item = items[0]
        assert item["workflow_id"] == started["workflow_id"]
        assert item["status"] == "completed"
        assert item["save_point_count"] == 3

        # Filter by status
        assert len(service.history_instances(status_filter="completed")) == 1
        assert len(service.history_instances(status_filter="failed")) == 0

        # 4. Verify savepoint detail retrieval
        save_points = service.state(started["workflow_id"])["save_points"]
        sp_id = save_points[0]["id"]
        detail = service.save_point_detail(started["workflow_id"], sp_id)
        assert detail["id"] == sp_id
        assert detail["phase"] == "before_harness"
        assert "subject" in detail["data"]

        # 5. Verify storage stats and packing
        stats = await service.storage_stats()
        assert stats["instances_count"] == 1
        assert stats["save_points_count"] >= 3

        pack_res = await service.pack_database()
        assert "reclaimed_human" in pack_res

        # 6. Verify deletion of historical instance
        assert await service.delete_instance(started["workflow_id"]) is True
        assert service.history_instances() == []

        # 7. Verify clear instances
        await service.start("graph_agent/data/workflows/agent_review_cycle.bpmn", None, {"subject": "text 2"})
        assert len(service.history_instances()) == 1
        assert await service.clear_instances() == 1
        assert service.history_instances() == []

    asyncio.run(scenario())
