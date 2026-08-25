"""Per-instance operations: state, diagram, workspace, forms, savepoints, fork,
messaging, and the live event stream. The largest router because "Instance" is where
most of the day-to-day API surface lives -- see AGENTS.md's data-flow summary for how
these fit together.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import tempfile
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response, StreamingResponse

from graph_agent.auth import Role, require_role
from graph_agent.models import (
    ForkRequest,
    MessageRequest,
    PurgeSavePointsRequest,
    PurgeSavePointsResponse,
    SubmitTaskRequest,
    WorkflowState,
)
from graph_agent.workflow_service import WorkflowNotFoundError, WorkflowService
from graph_agent.workspace import cleanup_workspace, extract_workspace_file, pack_workspace_to_bytes
from graph_agent.workspace_strategy import WorkspaceSnapshotUnsupportedError


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:  # noqa: C901, PLR0915 -- FastAPI's route-factory pattern nests every route in this one function by convention; splitting it up would fight the framework, not the complexity
    router = APIRouter()

    @router.get("/instance/{workflow_id}/events", tags=["Instance"], summary="Get audit event log for workflow")
    async def instance_events(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().get_events(workflow_id)

    @router.get("/instance/{workflow_id}/savepoint/{save_point_id}", tags=["Instance"], summary="Get savepoint detail")
    async def get_savepoint_detail(
        workflow_id: str,
        save_point_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().save_point_detail(workflow_id, save_point_id)
        except (WorkflowNotFoundError, KeyError) as exc:
            raise HTTPException(404, f"save point not found: {exc.args[0]}") from exc

    @router.delete("/instance/{workflow_id}/savepoints", response_model=PurgeSavePointsResponse, tags=["Instance"], summary="Purge savepoints older than an anchor")
    async def purge_instance_savepoints(
        workflow_id: str,
        request: PurgeSavePointsRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, int]:
        try:
            return await get_service().purge_save_points(
                workflow_id, before=request.before, before_task_id=request.before_task_id
            )
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/instance/{workflow_id}/state", response_model=WorkflowState, tags=["Instance"], summary="Get instance state")
    async def instance_state(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().state(workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

    @router.get("/instance/{workflow_id}/diagram", response_class=PlainTextResponse, tags=["Instance"], summary="Get instance BPMN diagram")
    async def instance_diagram(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> PlainTextResponse:
        try:
            return PlainTextResponse(await get_service().diagram(workflow_id), media_type="application/xml")
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except FileNotFoundError as exc:
            raise HTTPException(404, "BPMN diagram not found") from exc

    @router.get("/instance/{workflow_id}/workspace", tags=["Instance"], summary="Download instance workspace")
    async def download_workspace(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

        workspace_obj = get_service().get_workspace(workflow_id)

        if workspace_obj is None:
            empty_dir = tempfile.mkdtemp(prefix="bpmn-empty-")
            try:
                archive = await pack_workspace_to_bytes(empty_dir)
                return Response(
                    content=archive,
                    media_type="application/zstd",
                    headers={"Content-Disposition": f'attachment; filename="{workflow_id[:12]}-workspace.tar.zst"'},
                )
            finally:
                cleanup_workspace(empty_dir)

        if isinstance(workspace_obj, bytes):
            return Response(
                content=workspace_obj,
                media_type="application/zstd",
                headers={"Content-Disposition": f'attachment; filename="{workflow_id[:12]}-workspace.tar.zst"'},
            )

        # It's a Blob
        try:
            with workspace_obj.open("r") as f:
                content = f.read()
            if isinstance(content, str):
                content = content.encode()
        except Exception:
            content = b""

        return Response(
            content=content,
            media_type="application/zstd",
            headers={"Content-Disposition": f'attachment; filename="{workflow_id[:12]}-workspace.tar.zst"'},
        )

    @router.get("/instance/{workflow_id}/workspace/files", tags=["Instance"], summary="Get workspace file metadata manifest")
    async def instance_workspace_files(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            get_service().state(workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

        meta = get_service().get_workspace_metadata(workflow_id)
        return meta or {"file_count": 0, "total_size": 0, "files": [], "artifacts": []}

    @router.get("/instance/{workflow_id}/workspace/file", tags=["Instance"], summary="Extract and view single workspace file")
    async def instance_workspace_file(
        workflow_id: str,
        path: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

        workspace_obj = get_service().get_workspace(workflow_id)
        if not workspace_obj:
            raise HTTPException(404, "workspace is empty")

        file_bytes = await extract_workspace_file(workspace_obj, path)
        if file_bytes is None:
            raise HTTPException(404, f"file not found in workspace: {path}")

        media_type, _ = mimetypes.guess_type(path)
        return Response(
            content=file_bytes,
            media_type=media_type or "application/octet-stream",
            headers={"Content-Disposition": f'inline; filename="{Path(path).name}"'},
        )

    @router.get("/instance/{workflow_id}/form/{task_id}", tags=["Instance"], summary="Get FormJS schema for task")
    async def instance_form(
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

    @router.post("/instance/{workflow_id}/fork/{save_point_id}", response_model=WorkflowState, tags=["Instance"], summary="Fork workflow from savepoint")
    async def fork_instance(
        workflow_id: str,
        save_point_id: str,
        request: ForkRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().fork(workflow_id, save_point_id, request.variables)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except KeyError as exc:
            raise HTTPException(404, f"save point not found: {exc.args[0]}") from exc
        except WorkspaceSnapshotUnsupportedError as exc:
            # A typed body, not a bare string, so a client branches on `error`/`mode`
            # rather than parsing prose -- see docs/meta-agent-refactor-plan.md phase 3.
            raise HTTPException(
                409,
                {
                    "error": "workspace_snapshot_unsupported",
                    "mode": exc.mode,
                    "message": str(exc),
                },
            ) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/instance/{workflow_id}/submit-task/{task_id}", response_model=WorkflowState, tags=["Instance"], summary="Submit user task")
    async def instance_submit_task(
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

    @router.get("/instance/{workflow_id}/events/pending", tags=["Instance"], summary="List events the instance is waiting on")
    async def instance_pending_events(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return {"workflow_id": workflow_id, "pending": get_service().pending_events(workflow_id)}
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc

    @router.post("/instance/{workflow_id}/message/{message_name}", response_model=WorkflowState, tags=["Instance"], summary="Deliver an external message to a waiting catch event")
    async def instance_message(
        workflow_id: str,
        message_name: str,
        request: MessageRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().send_message(workflow_id, message_name, request.payload)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except KeyError as exc:
            raise HTTPException(409, str(exc)) from exc

    @router.post("/instance/{workflow_id}/retry/{task_id}", response_model=WorkflowState, tags=["Instance"], summary="Retry failed service task")
    async def retry_instance_task(
        workflow_id: str,
        task_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().retry_task(workflow_id, task_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except (KeyError, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    @router.post("/instance/{workflow_id}/cancel", response_model=WorkflowState, tags=["Instance"], summary="Cancel running workflow instance")
    async def cancel_instance(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().cancel(workflow_id)
        except WorkflowNotFoundError as exc:
            raise HTTPException(404, "workflow not found") from exc
        except KeyError as exc:
            raise HTTPException(404, "workflow not found") from exc

    @router.get("/instance/{workflow_id}/events/stream", tags=["Instance"], summary="Stream instance events via SSE")
    async def sse_events_stream(
        workflow_id: str,
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> StreamingResponse:
        svc = get_service()
        try:
            svc.state(workflow_id)
        except (WorkflowNotFoundError, KeyError) as exc:
            raise HTTPException(404, "workflow not found") from exc

        async def event_generator() -> AsyncGenerator[str, None]:
            initial = svc.state(workflow_id)
            yield f"data: {json.dumps(initial)}\n\n"
            last_status = initial.get("status")
            for _ in range(60):
                if await request.is_disconnected():
                    break
                await asyncio.sleep(0.5)
                current = svc.state(workflow_id)
                if current.get("status") != last_status or len(current.get("events", [])) > len(initial.get("events", [])):
                    last_status = current.get("status")
                    yield f"data: {json.dumps(current)}\n\n"
                    if last_status in ("completed", "failed", "cancelled"):
                        break

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    return router
