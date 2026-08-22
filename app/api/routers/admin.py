"""Legacy `/admin/*` endpoints, kept for existing clients alongside `/api/history/*`."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Header, HTTPException

from app.auth import Role, require_role
from app.models import ClearInstancesResponse, DeleteInstanceResponse, PackResult, WorkflowState
from app.workflow_service import WorkflowService


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.get("/admin/instances", response_model=list[WorkflowState], tags=["Admin"], summary="List instances for admin")
    async def admin_instances(
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> list[dict[str, Any]]:
        return get_service().instances()

    @router.post("/admin/pack", response_model=PackResult, tags=["Admin"], summary="Admin pack database", deprecated=True)
    async def admin_pack(
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, Any]:
        return await get_service().pack_database()

    @router.delete("/admin/instances/{workflow_id}", response_model=DeleteInstanceResponse, tags=["Admin"], summary="Admin delete instance")
    async def delete_instance(
        workflow_id: str,
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if not await get_service().delete_instance(workflow_id):
            raise HTTPException(404, "workflow not found")
        return {"deleted": workflow_id}

    @router.delete("/admin/instances", response_model=ClearInstancesResponse, tags=["Admin"], summary="Admin clear all instances")
    async def clear_instances(
        confirm: str = "",
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if confirm != "DELETE_ALL":
            raise HTTPException(400, "confirm=DELETE_ALL is required")
        return {"deleted": await get_service().clear_instances()}

    return router
