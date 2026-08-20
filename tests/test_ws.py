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
