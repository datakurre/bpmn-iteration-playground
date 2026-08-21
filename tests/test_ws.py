import asyncio
from unittest.mock import AsyncMock
import pytest
from app.ws import ConnectionManager


@pytest.mark.anyio
async def test_ws_broadcast_concurrent_and_pruning() -> None:
    cm = ConnectionManager()
    ws_slow1 = AsyncMock()
    ws_slow2 = AsyncMock()
    ws_failed = AsyncMock()

    async def slow_send(data):
        await asyncio.sleep(0.06)

    ws_slow1.send_json.side_effect = slow_send
    ws_slow2.send_json.side_effect = slow_send
    ws_failed.send_json.side_effect = RuntimeError("Disconnected")

    # Manually register mock websockets
    cm._connections["wf-1"] = {ws_slow1, ws_slow2, ws_failed}

    t0 = asyncio.get_event_loop().time()
    await cm.broadcast("wf-1", {"status": "running"})
    duration = asyncio.get_event_loop().time() - t0

    # If concurrent, duration < 0.10s; if sequential, duration >= 0.12s
    assert duration < 0.10

    # Assert calls
    ws_slow1.send_json.assert_awaited_once_with({"status": "running"})
    ws_slow2.send_json.assert_awaited_once_with({"status": "running"})
    ws_failed.send_json.assert_awaited_once_with({"status": "running"})

    # Failed socket should have been pruned
    assert ws_failed not in cm._connections["wf-1"]
    assert ws_slow1 in cm._connections["wf-1"]
    assert ws_slow2 in cm._connections["wf-1"]


@pytest.mark.anyio
async def test_ws_connect_creates_and_reuses_connection_set() -> None:
    cm = ConnectionManager()
    ws1 = AsyncMock()
    ws2 = AsyncMock()

    await cm.connect("wf-connect", ws1)
    assert cm._connections["wf-connect"] == {ws1}

    # Second connect for the same workflow_id reuses the existing set.
    await cm.connect("wf-connect", ws2)
    assert cm._connections["wf-connect"] == {ws1, ws2}
    ws1.accept.assert_awaited_once()
    ws2.accept.assert_awaited_once()


def test_ws_disconnect_unknown_workflow_is_a_noop() -> None:
    cm = ConnectionManager()
    cm.disconnect("no-such-workflow", AsyncMock())  # must not raise


def test_ws_disconnect_leaves_other_connections_intact() -> None:
    cm = ConnectionManager()
    ws1, ws2 = AsyncMock(), AsyncMock()
    cm._connections["wf-1"] = {ws1, ws2}
    cm.disconnect("wf-1", ws1)
    assert cm._connections["wf-1"] == {ws2}


def test_ws_disconnect_removes_key_when_last_connection_leaves() -> None:
    cm = ConnectionManager()
    ws1 = AsyncMock()
    cm._connections["wf-1"] = {ws1}
    cm.disconnect("wf-1", ws1)
    assert "wf-1" not in cm._connections


@pytest.mark.anyio
async def test_ws_broadcast_to_unknown_workflow_is_a_noop() -> None:
    cm = ConnectionManager()
    await cm.broadcast("no-such-workflow", {"status": "running"})  # must not raise


@pytest.mark.anyio
async def test_ws_broadcast_removes_key_when_all_connections_fail() -> None:
    cm = ConnectionManager()
    ws_failed = AsyncMock()
    ws_failed.send_json.side_effect = RuntimeError("Disconnected")
    cm._connections["wf-1"] = {ws_failed}

    await cm.broadcast("wf-1", {"status": "running"})
    assert "wf-1" not in cm._connections
