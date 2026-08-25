import asyncio
from pathlib import Path

import pytest

from bpmn_agent.agents_root import Workspace
from bpmn_agent.workspace_strategy import InPlaceStrategy


@pytest.mark.anyio
async def test_acquire_returns_the_workspace_root(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    strategy = InPlaceStrategy(ws)

    path = await strategy.acquire("run-1")

    assert path == ws.root
    await strategy.release("run-1")


@pytest.mark.anyio
async def test_supports_snapshot_is_false_and_snapshot_returns_none(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    strategy = InPlaceStrategy(ws)

    assert strategy.supports_snapshot is False
    assert await strategy.snapshot("run-1", "before_harness") is None


@pytest.mark.anyio
async def test_restore_raises_not_implemented(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    strategy = InPlaceStrategy(ws)

    with pytest.raises(NotImplementedError):
        await strategy.restore("whatever", "run-2")


@pytest.mark.anyio
async def test_release_is_idempotent(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    strategy = InPlaceStrategy(ws)

    await strategy.acquire("run-1")
    await strategy.release("run-1")
    await strategy.release("run-1")  # must not raise


@pytest.mark.anyio
async def test_discard_never_raises_even_without_a_prior_acquire(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    strategy = InPlaceStrategy(ws)

    await strategy.discard("never-acquired")


@pytest.mark.anyio
async def test_two_turns_serialise_through_a_shared_workspace_lock(tmp_path: Path) -> None:
    ws = Workspace.discover(tmp_path)
    strategy_a = InPlaceStrategy(ws)
    strategy_b = InPlaceStrategy(ws)  # a fresh instance, as a new turn dispatch would build

    order: list[str] = []
    second_acquired = asyncio.Event()

    async def turn_a() -> None:
        await strategy_a.acquire("run-a")
        order.append("a-acquired")
        await asyncio.sleep(0.05)
        order.append("a-releasing")
        await strategy_a.release("run-a")

    async def turn_b() -> None:
        await asyncio.sleep(0.01)  # ensure turn_a acquires first
        await strategy_b.acquire("run-b")
        second_acquired.set()
        order.append("b-acquired")
        await strategy_b.release("run-b")

    await asyncio.gather(turn_a(), turn_b())

    # b could only acquire after a released -- serialised, not concurrent.
    assert order == ["a-acquired", "a-releasing", "b-acquired"]


@pytest.mark.anyio
async def test_different_workspaces_do_not_share_a_lock(tmp_path: Path) -> None:
    ws_a = Workspace.discover(tmp_path / "one")
    ws_b = Workspace.discover(tmp_path / "two")
    strategy_a = InPlaceStrategy(ws_a)
    strategy_b = InPlaceStrategy(ws_b)

    await strategy_a.acquire("run-1")
    # Must not block: a different workspace root has its own, independent lock.
    await asyncio.wait_for(strategy_b.acquire("run-2"), timeout=1.0)

    await strategy_a.release("run-1")
    await strategy_b.release("run-2")
