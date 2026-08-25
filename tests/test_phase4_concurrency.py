import asyncio
from pathlib import Path
from typing import Any

import pytest

from graph_agent.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter
from graph_agent.adapters.registry import AdapterRegistry
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService


class ConcurrencyTrackingAdapter(BaseAdapter):
    def __init__(self) -> None:
        self.current_concurrent = 0
        self.peak_concurrent = 0
        self._lock = asyncio.Lock()

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    @property
    def capabilities(self) -> AdapterCapabilities:
        return AdapterCapabilities(display_name="Concurrency Tracker", supports_sessions=False)

    async def run(
        self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None
    ) -> AgentResult:
        async with self._lock:
            self.current_concurrent += 1
            if self.current_concurrent > self.peak_concurrent:
                self.peak_concurrent = self.current_concurrent

        try:
            await asyncio.sleep(0.05)
            return AgentResult(
                status="success",
                output={"status": "success", "summary": "done", "findings": [], "artifacts": [], "next_action": "none"},
                text="done",
                messages=[],
                stderr="",
                exit_code=0,
            )
        finally:
            async with self._lock:
                self.current_concurrent -= 1


@pytest.mark.anyio
async def test_turn_concurrency_bounds_parallel_executions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_PARALLEL_TURNS", "2")
    store = WorkflowStore(tmp_path / "data")
    adapter = ConcurrencyTrackingAdapter()
    registry = AdapterRegistry()
    registry.register(adapter)
    registry.bind("pi_agent", adapter)

    service = WorkflowService(store=store, adapter_registry=registry)
    assert service.max_parallel_turns == 2

    # Start 4 workflows concurrently
    bpmn_path = "graph_agent/data/workflows/plan_and_execute.bpmn"
    states = await asyncio.gather(
        service.start(bpmn_path, variables={"goal": "run 1"}),
        service.start(bpmn_path, variables={"goal": "run 2"}),
        service.start(bpmn_path, variables={"goal": "run 3"}),
        service.start(bpmn_path, variables={"goal": "run 4"}),
    )

    # Wait for all background jobs to finish
    for _ in range(50):
        running = any(j.get("status") == "running" for s in states for j in service.state(s["workflow_id"]).get("jobs", {}).values())
        if not running and all(service.state(s["workflow_id"])["status"] in ("completed", "waiting_human", "failed") for s in states):
            break
        await asyncio.sleep(0.05)

    assert adapter.peak_concurrent <= 2
    assert adapter.peak_concurrent > 0
    await service.shutdown()


@pytest.mark.parametrize("raw_value", ["0", "-1", "-100"])
def test_max_parallel_turns_is_clamped_to_at_least_one(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raw_value: str) -> None:
    """MAX_PARALLEL_TURNS=0 would make `asyncio.Semaphore(0)` never grant a permit,
    silently deadlocking every agent turn forever; a negative value raises ValueError out
    of the Semaphore constructor, crashing __init__ outright. Both must fail safe."""
    monkeypatch.setenv("MAX_PARALLEL_TURNS", raw_value)
    store = WorkflowStore(tmp_path / "data")

    service = WorkflowService(store=store)

    assert service.max_parallel_turns == 1
    assert service._turn_semaphore._value == 1


def test_max_parallel_turns_falls_back_to_default_when_not_a_number(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_PARALLEL_TURNS", "not-a-number")
    store = WorkflowStore(tmp_path / "data")

    service = WorkflowService(store=store)

    assert service.max_parallel_turns == 4
