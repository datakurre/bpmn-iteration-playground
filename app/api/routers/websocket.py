"""Live push channel for one workflow instance (/ws/instance/{workflow_id})."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import Role, _is_require_auth, parse_auth_config
from app.workflow_service import WorkflowService
from app.ws import manager as ws_manager


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.websocket("/ws/instance/{workflow_id}")
    async def ws_instance(websocket: WebSocket, workflow_id: str) -> None:
        admin_token, api_keys, auth_enabled = parse_auth_config()
        require_auth = _is_require_auth()

        if auth_enabled or require_auth:
            x_api_key = (
                websocket.headers.get("x-api-key")
                or websocket.query_params.get("api_key")
                or websocket.query_params.get("x-api-key")
                or websocket.query_params.get("token")
            )
            x_admin_token = (
                websocket.headers.get("x-admin-token")
                or websocket.query_params.get("admin_token")
                or websocket.query_params.get("x-admin-token")
            )
            role = None
            if admin_token and x_admin_token == admin_token:
                role = Role.ADMIN
            elif x_api_key:
                if admin_token and x_api_key == admin_token:
                    role = Role.ADMIN
                elif x_api_key in api_keys:
                    role = api_keys[x_api_key]

            if not auth_enabled and require_auth:
                await websocket.close(code=1008, reason="Authentication required by policy")
                return

            if role is None:
                await websocket.close(code=1008, reason="Unauthorized")
                return

        await ws_manager.connect(workflow_id, websocket)
        try:
            svc = get_service()
            try:
                initial_state = svc.state(workflow_id)
                await websocket.send_json(initial_state)
            except Exception:
                pass
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            ws_manager.disconnect(workflow_id, websocket)
        except Exception:
            ws_manager.disconnect(workflow_id, websocket)

    return router
