"""Inbound BPMN integration: message catch events and timer events."""

import asyncio

from graph_agent.adapters.base import AgentResult, BaseAdapter
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService


class StubAgent(BaseAdapter):
    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt, config, cwd, on_event=None) -> AgentResult:
        return AgentResult(
            status="success",
            output={
                "status": "success",
                "summary": "prepared",
                "findings": [],
                "artifacts": [],
                "next_action": "continue",
            },
            text="ok",
            session_id="session-1",
        )


async def _drain(service) -> None:
    while any(not job.done() for job in list(service.jobs.values())):
        pending = [job for job in list(service.jobs.values()) if not job.done()]
        if pending:
            await asyncio.gather(*pending)
        await asyncio.sleep(0.01)


def test_workflow_parks_on_message_and_resumes_on_delivery() -> None:
    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), StubAgent())
        started = await service.start(
            "graph_agent/data/workflows/external_gate.bpmn", None, {"change_request": "bump the timeout"}
        )
        workflow_id = started["workflow_id"]
        await asyncio.wait_for(_drain(service), timeout=5.0)

        state = service.state(workflow_id)
        assert state["status"] == "waiting_event"
        pending = service.pending_events(workflow_id)
        assert [event["name"] for event in pending] == ["external_approval"]
        assert pending[0]["event_type"] == "MessageEventDefinition"

        resumed = await service.send_message(
            workflow_id, "external_approval", {"approval_decision": "approved", "approved_by": "ops"}
        )
        await asyncio.wait_for(_drain(service), timeout=5.0)

        final = service.state(workflow_id)
        assert resumed["status"] in ("running", "waiting_pi", "completed")
        assert final["status"] == "completed"
        # payload is routable data, and it steered the gateway
        assert final["data"]["approved_by"] == "ops"
        assert final["data"]["apply_status"] == "success"

    asyncio.run(scenario())


def test_declined_message_skips_the_apply_turn() -> None:
    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), StubAgent())
        started = await service.start("graph_agent/data/workflows/external_gate.bpmn", None, {"change_request": "x"})
        workflow_id = started["workflow_id"]
        await asyncio.wait_for(_drain(service), timeout=5.0)

        await service.send_message(workflow_id, "external_approval", {"approval_decision": "declined"})
        await asyncio.wait_for(_drain(service), timeout=5.0)

        final = service.state(workflow_id)
        assert final["status"] == "completed"
        assert "apply_status" not in final["data"]

    asyncio.run(scenario())


def test_unknown_message_name_is_rejected() -> None:
    async def scenario() -> None:
        import pytest

        service = WorkflowService(WorkflowStore(":memory:"), StubAgent())
        started = await service.start("graph_agent/data/workflows/external_gate.bpmn", None, {"change_request": "x"})
        await asyncio.wait_for(_drain(service), timeout=5.0)

        with pytest.raises(KeyError):
            await service.send_message(started["workflow_id"], "not_a_message", {})

    asyncio.run(scenario())


def test_timer_event_fires_on_refresh() -> None:
    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), StubAgent())
        started = await service.start("tests/fixtures/timer_gate.bpmn", "timer_gate", {})
        workflow_id = started["workflow_id"]

        # Parked on the timer: nothing advances until something refreshes waiting tasks
        assert service.state(workflow_id)["status"] == "waiting_event"
        assert await service.refresh_timers() == []
        assert service.state(workflow_id)["status"] == "waiting_event"

        await asyncio.sleep(0.15)
        assert await service.refresh_timers() == [workflow_id]
        assert service.state(workflow_id)["status"] == "completed"

    asyncio.run(scenario())


def test_timer_loop_starts_and_stops() -> None:
    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), StubAgent())
        started = await service.start("tests/fixtures/timer_gate.bpmn", "timer_gate", {})
        workflow_id = started["workflow_id"]

        service.start_timer_loop(interval=0.05)
        service.start_timer_loop(interval=0.05)  # idempotent
        for _ in range(40):
            await asyncio.sleep(0.05)
            if service.state(workflow_id)["status"] == "completed":
                break
        assert service.state(workflow_id)["status"] == "completed"

        await service.stop_timer_loop()
        assert service._timer_task is None

    asyncio.run(scenario())
