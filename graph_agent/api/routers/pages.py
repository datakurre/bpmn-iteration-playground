"""Server-rendered HTML pages (dashboard, history, admin, editor, instance view)."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, Response

from graph_agent.api.ui import admin_page, editor_page, history_detail_page, history_page, instance_page, page
from graph_agent.auth import Role, require_role
from graph_agent.workflow_service import WorkflowNotFoundError, WorkflowService


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.get("/", response_class=HTMLResponse, tags=["UI"], summary="Workflow Studio Dashboard")
    async def dashboard(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return page(request)

    @router.get("/history", response_class=HTMLResponse, tags=["UI"], summary="Execution History UI")
    async def history_ui(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return history_page(request)

    @router.get("/history/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Historical Instance Detail UI")
    async def history_detail_ui(
        request: Request,
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
            return history_detail_page(request, workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

    @router.get("/admin", response_class=HTMLResponse, tags=["UI"], summary="Administrative Panel UI")
    async def admin(
        request: Request,
        role: Role = require_role(Role.ADMIN),
    ) -> Response:
        return admin_page(request)

    @router.get("/editor", response_class=HTMLResponse, tags=["UI"], summary="BPMN Modeler Editor UI")
    async def editor_ui(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return editor_page(request)

    @router.get("/instance/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Live Workflow Instance View")
    async def instance(
        request: Request,
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
            return instance_page(request, workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

    return router
