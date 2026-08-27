"""Projects: `/project` list/create/detail/spawn over `ProjectService`.

This is the API half of plans/concepts.md's Backlog item 2 (`POST /project` + `GET
/project`). The dashboard becoming a Project list, and a dedicated Project view UI
(Backlog item 3), are not done here -- those are a real UI design surface, not a
mechanical wiring of what `graph_agent/projects.py` already provides.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException

from graph_agent.auth import Role, require_role
from graph_agent.models import CreateProjectRequest, ProjectDetail, ProjectSummary, SpawnTaskRequest
from graph_agent.projects import DuplicateProjectError, ProjectNotFoundError, ProjectService


def build_router(get_project_service: Callable[[], ProjectService]) -> APIRouter:  # noqa: C901
    router = APIRouter()

    @router.post("/project", response_model=ProjectDetail, tags=["Projects"], summary="Open a new Project")
    async def create_project(
        body: CreateProjectRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_project_service().create(body.name, body.bpmn_path, body.variables)
        except DuplicateProjectError as exc:
            raise HTTPException(409, f"a Project named {exc.args[0]!r} already exists") from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(404, "BPMN file not found") from exc

    @router.get("/project", response_model=list[ProjectSummary], tags=["Projects"], summary="List Projects")
    async def list_projects(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_project_service().list_projects()

    @router.get(
        "/project/current",
        response_model=ProjectDetail,
        tags=["Projects"],
        summary="Get current workspace Project detail",
    )
    async def get_current_project(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_project_service().get("current")
        except ProjectNotFoundError as exc:
            raise HTTPException(404, "no active Project in this workspace") from exc

    @router.post("/project/spawn", tags=["Projects"], summary="Spawn a child task into the current workspace Project")
    async def spawn_current_project_task(
        body: SpawnTaskRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_project_service().spawn("current", body.task_brief, body.payload)
        except ProjectNotFoundError as exc:
            raise HTTPException(404, "no active Project in this workspace") from exc
        except KeyError as exc:
            raise HTTPException(409, str(exc)) from exc

    @router.get("/project/{slug}", response_model=ProjectDetail, tags=["Projects"], summary="Get Project detail")
    async def get_project(
        slug: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_project_service().get(slug)
        except ProjectNotFoundError as exc:
            raise HTTPException(404, f"no Project matches {exc.args[0]!r}") from exc

    @router.post("/project/{slug}/spawn", tags=["Projects"], summary="Spawn a child task into a Project")
    async def spawn_project_task(
        slug: str,
        body: SpawnTaskRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_project_service().spawn(slug, body.task_brief, body.payload)
        except ProjectNotFoundError as exc:
            raise HTTPException(404, f"no Project matches {exc.args[0]!r}") from exc
        except KeyError as exc:
            raise HTTPException(409, str(exc)) from exc

    return router
