"""The original pre-`/instance` API surface. `submit-task`/`form` are kept for
existing clients; `/instance/*` (instance.py) is the current equivalent."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException

from app.auth import Role, require_role
from app.models import StartWorkflowRequest, SubmitTaskRequest, WorkflowState
from app.workflow_service import WorkflowNotFoundError, WorkflowService


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.post("/workflow/start", response_model=WorkflowState, tags=["Workflow"], summary="Start a new workflow instance")
    async def start(
        request: StartWorkflowRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().start(request.bpmn_path, request.process_id, request.variables)
        except FileNotFoundError as exc:
            raise HTTPException(404, "BPMN file not found") from exc

    @router.get("/workflow/{workflow_id}/state", response_model=WorkflowState, tags=["Workflow"], summary="Get workflow execution state")
    async def state(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().state(workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

    @router.post("/workflow/{workflow_id}/submit-task/{task_id}", response_model=WorkflowState, tags=["Workflow"], summary="Submit human task by ID", deprecated=True)
    async def submit_task(
        workflow_id: str,
        task_id: str,
        request: SubmitTaskRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().submit_task(workflow_id, task_id, request.variables)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except (KeyError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @router.post("/workflow/{workflow_id}/submit-task", response_model=WorkflowState, tags=["Workflow"], summary="Submit human task via JSON body")
    async def submit_task_body(
        workflow_id: str,
        request: SubmitTaskRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        if not request.task_id:
            raise HTTPException(422, "task_id is required")
        return await submit_task(workflow_id, request.task_id, request, role)

    @router.get("/workflow/{workflow_id}/form/{task_id}", tags=["Workflow"], summary="Get FormJS schema for task")
    async def form(
        workflow_id: str,
        task_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().form(workflow_id, task_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except (KeyError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    return router
