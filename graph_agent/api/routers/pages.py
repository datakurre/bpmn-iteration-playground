"""Server-rendered HTML pages (dashboard, history, admin, editor, instance view)."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, Response

from graph_agent.api.ui import admin_page, editor_page, history_detail_page, history_page, instance_page, page
from graph_agent.auth import Role, require_role
from graph_agent.workflow_service import WorkflowNotFoundError, WorkflowService


def _with_auth_cookie(request: Request, response: Response) -> Response:
    token = (
        request.query_params.get("token")
        or request.query_params.get("admin_token")
        or request.query_params.get("api_key")
    )
    if token:
        response.set_cookie(key="admin_token", value=token, httponly=True, samesite="lax", path="/")
    return response


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.get("/", response_class=HTMLResponse, tags=["UI"], summary="Workflow Studio Dashboard")
    async def dashboard(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return _with_auth_cookie(request, page(request))

    @router.get("/history", response_class=HTMLResponse, tags=["UI"], summary="Execution History UI")
    async def history_ui(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return _with_auth_cookie(request, history_page(request))

    @router.get("/history/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Historical Instance Detail UI")
    async def history_detail_ui(
        request: Request,
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
            return _with_auth_cookie(request, history_detail_page(request, workflow_id))
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

    @router.get("/admin", response_class=HTMLResponse, tags=["UI"], summary="Administrative Panel UI")
    async def admin(
        request: Request,
        role: Role = require_role(Role.ADMIN),
    ) -> Response:
        return _with_auth_cookie(request, admin_page(request))

    @router.get("/editor", response_class=HTMLResponse, tags=["UI"], summary="BPMN Modeler Editor UI")
    @router.get("/editor/{template}", response_class=HTMLResponse, tags=["UI"], summary="BPMN Modeler Editor UI")
    async def editor_ui(
        request: Request,
        template: str | None = None,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return _with_auth_cookie(request, editor_page(request))

    @router.get("/instance/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Live Workflow Instance View")
    async def instance(
        request: Request,
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
            return _with_auth_cookie(request, instance_page(request, workflow_id))
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

    return router

