"""MAX_PARALLEL_TURNS bounds concurrent *harness execution*, not concurrent dispatch --
several instances can all be waiting_pi with a job entry at once, but only this many ever
have a live adapter.run() call in flight.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from bpmn_agent.adapters.base import AgentResult, BaseAdapter
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.workflow_service import WorkflowService


class ConcurrencyTrackingAdapter(BaseAdapter):
    """Records the peak number of simultaneously in-flight run() calls, and blocks each
    call until released, so overlap is forced rather than left to scheduling luck."""

    def __init__(self, release_after: asyncio.Event) -> None:
        self.release_after = release_after
        self.current = 0
        self.peak = 0
        self.calls = 0
        self._lock = asyncio.Lock()

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
        async with self._lock:
            self.calls += 1
            self.current += 1
            self.peak = max(self.peak, self.current)
        await self.release_after.wait()
        async with self._lock:
            self.current -= 1
        return AgentResult(
            "success",
            {"status": "success", "summary": "ok", "findings": [], "artifacts": [], "next_action": "continue"},
            "ok",
        )


async def _start_n_instances(service: WorkflowService, n: int) -> list[str]:
    ids = []
    for _ in range(n):
        started = await service.start(
            "tests/fixtures/sequential_agents.bpmn", "sequential_agents", {}
        )
        ids.append(started["workflow_id"])
    return ids


@pytest.mark.anyio
async def test_concurrent_harness_execution_is_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_PARALLEL_TURNS", "2")
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None)
    release = asyncio.Event()
    adapter = ConcurrencyTrackingAdapter(release)
    service.registry.register(adapter)

    await _start_n_instances(service, 5)

    # Give every dispatched turn a chance to reach (and queue behind) the semaphore.
    for _ in range(50):
        if adapter.calls >= 2:
            break
        await asyncio.sleep(0.01)

    assert adapter.peak <= 2, "MAX_PARALLEL_TURNS=2 must never allow more than 2 concurrent adapter.run() calls"
    assert adapter.calls >= 2, "at least the first batch should have started"

    release.set()
    await asyncio.wait_for(
        asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()], return_exceptions=True),
        timeout=5.0,
    )

    assert adapter.peak == 2, "5 instances queued behind a limit of 2 should reach exactly the cap, not less"
    store.close()


@pytest.mark.anyio
async def test_default_max_parallel_turns_is_four(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MAX_PARALLEL_TURNS", raising=False)
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None)
    assert service._harness_semaphore._value == 4
    store.close()


@pytest.mark.anyio
async def test_invalid_max_parallel_turns_falls_back_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_PARALLEL_TURNS", "not-a-number")
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None)
    assert service._harness_semaphore._value == 4
    store.close()


@pytest.mark.anyio
async def test_max_parallel_turns_of_one_fully_serialises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAX_PARALLEL_TURNS", "1")
    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None)
    release = asyncio.Event()
    adapter = ConcurrencyTrackingAdapter(release)
    service.registry.register(adapter)

    await _start_n_instances(service, 3)
    for _ in range(50):
        if adapter.calls >= 1:
            break
        await asyncio.sleep(0.01)

    assert adapter.peak == 1
    release.set()
    await asyncio.wait_for(
        asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()], return_exceptions=True),
        timeout=5.0,
    )
    assert adapter.peak == 1
    store.close()
