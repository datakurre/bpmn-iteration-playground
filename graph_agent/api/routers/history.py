"""ZODB storage stats/compaction and historical-instance browsing."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException

from graph_agent.auth import Role, require_role
from graph_agent.models import ClearInstancesResponse, DeleteInstanceResponse, PackResult, StorageStats, WorkflowState
from graph_agent.workflow_service import WorkflowService


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.get(
        "/api/history/storage", response_model=StorageStats, tags=["History"], summary="Get ZODB storage statistics"
    )
    async def api_history_storage(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        return await get_service().storage_stats()

    @router.post(
        "/api/history/pack", response_model=PackResult, tags=["History"], summary="Pack and compact ZODB database"
    )
    async def api_history_pack(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        return await get_service().pack_database()

    @router.get(
        "/api/history/instances",
        response_model=list[WorkflowState],
        tags=["History"],
        summary="List historical workflow instances",
    )
    async def api_history_instances(
        status: str | None = None,
        limit: int | None = None,
        offset: int = 0,
        since: str | None = None,
        until: str | None = None,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().history_instances(
            status_filter=status,
            limit=limit,
            offset=offset,
            since=since,
            until=until,
        )

    @router.delete(
        "/api/history/instances/{workflow_id}",
        response_model=DeleteInstanceResponse,
        tags=["History"],
        summary="Delete historical workflow instance",
    )
    async def delete_history_instance(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if not await get_service().delete_instance(workflow_id):
            raise HTTPException(404, "workflow not found")
        return {"deleted": workflow_id}

    @router.delete(
        "/api/history/instances",
        response_model=ClearInstancesResponse,
        tags=["History"],
        summary="Clear all history instances",
    )
    async def clear_history_instances(
        confirm: str = "",
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if confirm != "DELETE_ALL":
            raise HTTPException(400, "confirm=DELETE_ALL is required")
        return {"deleted": await get_service().clear_instances()}

    @router.get(
        "/api/history/sessions",
        response_model=list[dict[str, Any]],
        tags=["History"],
        summary="List historical agent sessions from ZODB",
    )
    async def api_history_sessions(
        workflow_id: str | None = None,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().list_sessions(workflow_id=workflow_id)

    @router.get(
        "/api/history/sessions/{session_id}",
        response_model=dict[str, Any],
        tags=["History"],
        summary="Get historical agent session from ZODB",
    )
    async def api_history_session_detail(
        session_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        session = get_service().get_session(session_id)
        if session is None:
            raise HTTPException(404, "session not found")
        return session

    return router
