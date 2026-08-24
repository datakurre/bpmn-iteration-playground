import asyncio
from typing import Any

from app.adapters.base import AgentResult, BaseAdapter
from app.adapters.mock_adapter import MockAdapter
from app.adapters.registry import AdapterRegistry
from app.persistence import WorkflowStore
from app.workflow_service import WorkflowService


class CustomSecurityAdapter(BaseAdapter):
    @property
    def adapter_type(self) -> str:
        return "custom_sec_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
        return AgentResult(
            status="success",
            output={
                "status": "success",
                "summary": "Security audit clean",
                "findings": ["no vulnerabilities found"],
                "artifacts": [],
                "next_action": "continue",
            },
            text="Clean security report",
            messages=[],
            stderr="",
            exit_code=0,
        )


def test_adapter_registry_and_custom_adapter_execution() -> None:
    async def scenario() -> None:
        registry = AdapterRegistry()
        mock = MockAdapter(status="success")
        sec = CustomSecurityAdapter()
        registry.register(mock)
        registry.register(sec)
        registry.bind("pi_agent", mock)

        assert "pi_agent" in registry.list_types()
        assert "mock_agent" in registry.list_types()
        assert "custom_sec_agent" in registry.list_types()

        store = WorkflowStore(":memory:")
        service = WorkflowService(store, adapter_registry=registry)

        started = await service.start("workflows/contract_review.bpmn", None, {"contract": "Test"})
        wf_id = started["workflow_id"]

        async def _wait():
            while any(not job.done() for job in list(service.jobs.values())):
                pending = [job for job in list(service.jobs.values()) if not job.done()]
                if pending:
                    await asyncio.gather(*pending)
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait(), timeout=5.0)

        state = service.state(wf_id)
        assert state["status"] == "waiting_human"

    asyncio.run(scenario())
