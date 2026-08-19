from __future__ import annotations

import logging
from typing import Any, Dict, Set
from fastapi import WebSocket

logger = logging.getLogger("bpmn.ws")


class ConnectionManager:
    """Manages active WebSocket connections for live workflow state push updates."""

    def __init__(self) -> None:
        self._connections: Dict[str, Set[WebSocket]] = {}

    async def connect(self, workflow_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        if workflow_id not in self._connections:
            self._connections[workflow_id] = set()
        self._connections[workflow_id].add(websocket)

    def disconnect(self, workflow_id: str, websocket: WebSocket) -> None:
        conns = self._connections.get(workflow_id)
        if conns:
            conns.discard(websocket)
            if not conns:
                del self._connections[workflow_id]

    async def broadcast(self, workflow_id: str, data: dict[str, Any]) -> None:
        conns = self._connections.get(workflow_id)
        if not conns:
            return

        dead_connections = set()
        for ws in list(conns):
            try:
                await ws.send_json(data)
            except Exception as exc:
                logger.debug(f"Failed to send WS message to client: {exc}")
                dead_connections.add(ws)

        for ws in dead_connections:
            conns.discard(ws)
        if not conns and workflow_id in self._connections:
            del self._connections[workflow_id]


manager = ConnectionManager()
