import asyncio
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.api.ui import admin_page, editor_page, history_detail_page, history_page, instance_page, page
from app.auth import Role, _is_require_auth, parse_auth_config, require_role
from app.logging_config import RequestLoggingMiddleware, configure_logging
from app.models import (
    AdminCleanupRequest,
    ClearInstancesResponse,
    DeleteInstanceResponse,
    DeleteWebhookResponse,
    ForkRequest,
    PackResult,
    SavePointSummary,
    SaveWorkflowResponse,
    StartWorkflowRequest,
    StorageStats,
    SubmitTaskRequest,
    TemplateSummary,
    WebhookRegistration,
    WorkflowState,
)
from app.persistence import WorkflowStore
from app.registry import WorkflowRegistry
from app.workflow_service import WorkflowNotFound, WorkflowService
from app.ws import manager as ws_manager
from app.xml_utils import safe_fromstring_xml

logger = logging.getLogger("bpmn.api")
configure_logging()


class SaveWorkflowRequest(BaseModel):
    name: str
    xml: str


from contextlib import asynccontextmanager

def create_app(service: WorkflowService | None = None) -> FastAPI:
    _service = service
    registry = WorkflowRegistry()

    def get_service() -> WorkflowService:
        nonlocal _service
        if _service is None:
            _service = WorkflowService(WorkflowStore())
        return _service

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging(os.getenv("LOG_LEVEL", "INFO"))
        try:
            svc = get_service()
            recovered = await svc.recover_orphaned_workflows()
            if recovered:
                logger.info(f"Startup recovery cleaned up {recovered} orphaned workflows")
        except Exception as exc:
            logger.warning(f"Startup recovery check failed: {exc}")
        yield

    app = FastAPI(
        title="BPMN Pi Workflow API",
        description=(
            "Durable BPMN 2.0 orchestration engine powered by local Pi AI agents, "
            "ZODB persistence, SavePoint forks, and FormJS human checkpoints."
        ),
        version="0.1.0",
        lifespan=lifespan,
        openapi_tags=[
            {"name": "Workflow", "description": "Start and manage active workflow executions"},
            {"name": "Instance", "description": "Inspect and interact with workflow instances"},
            {"name": "History", "description": "Browse execution history and savepoints"},
            {"name": "Webhooks", "description": "Event subscription and delivery"},
            {"name": "Templates", "description": "BPMN template discovery and catalog"},
            {"name": "Admin", "description": "Administrative maintenance and storage compaction"},
        ],
    )

    app.add_middleware(RequestLoggingMiddleware)

    bpmn_assets = Path(__file__).resolve().parents[2] / "node_modules" / "bpmn-js" / "dist"
    form_assets = Path(__file__).resolve().parents[2] / "node_modules" / "@bpmn-io" / "form-js" / "dist"
    app_static = Path(__file__).resolve().parents[2] / "app" / "static"
    if app_static.is_dir():
        app.mount("/static/app", StaticFiles(directory=app_static), name="app-static")
    if form_assets.is_dir():
        app.mount("/static/form-js", StaticFiles(directory=form_assets), name="form-static")
    if bpmn_assets.is_dir():
        app.mount("/static", StaticFiles(directory=bpmn_assets), name="static")

    # Public health check
    @app.get("/health", tags=["System"], summary="Health check endpoint")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    # UI routes
    @app.get("/", response_class=HTMLResponse, tags=["UI"], summary="Workflow Studio Dashboard")
    async def dashboard(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return page(request)

    @app.get("/history", response_class=HTMLResponse, tags=["UI"], summary="Execution History UI")
    async def history_ui(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return history_page(request)

    @app.get("/history/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Historical Instance Detail UI")
    async def history_detail_ui(
        request: Request,
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
            return history_detail_page(request, workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

    @app.get("/admin", response_class=HTMLResponse, tags=["UI"], summary="Administrative Panel UI")
    async def admin(
        request: Request,
        role: Role = require_role(Role.ADMIN),
    ) -> Response:
        return admin_page(request)

    @app.get("/editor", response_class=HTMLResponse, tags=["UI"], summary="BPMN Modeler Editor UI")
    async def editor_ui(
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        return editor_page(request)

    @app.get("/instance/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Live Workflow Instance View")
    async def instance(
        request: Request,
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
            return instance_page(request, workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

    # WebSocket Real-Time Updates (TODO 12)
    @app.websocket("/ws/instance/{workflow_id}")
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

    # Template Registry (TODO 08)
    @app.get("/api/templates", response_model=list[TemplateSummary], tags=["Templates"], summary="List available BPMN templates")
    async def list_templates(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return [t.to_dict() for t in registry.list_templates()]

    @app.get("/api/templates/{process_id}", response_model=TemplateSummary, tags=["Templates"], summary="Get template metadata")
    async def get_template(
        process_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        template = registry.get_template(process_id)
        if not template:
            raise HTTPException(404, "template not found")
        return template.to_dict()

    @app.get("/api/templates/{process_id}/xml", response_class=PlainTextResponse, tags=["Templates"], summary="Get template raw BPMN XML")
    async def get_template_xml(
        process_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> PlainTextResponse:
        template = registry.get_template(process_id)
        if not template:
            raise HTTPException(404, "template not found")
        path = Path(template.path)
        if not path.is_file():
            raise HTTPException(404, "template file not found")
        return PlainTextResponse(await asyncio.to_thread(path.read_text, encoding="utf-8"), media_type="application/xml")

    # Workflow Save Endpoint (TODO 20)
    @app.post("/api/workflows/save", response_model=SaveWorkflowResponse, tags=["Templates"], summary="Save or update BPMN XML file")
    async def save_workflow(
        body: SaveWorkflowRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        import io
        from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser

        parser = BpmnParser()
        try:
            safe_fromstring_xml(body.xml)
            parser.add_bpmn_io(io.BytesIO(body.xml.encode("utf-8")))
        except Exception as exc:
            raise HTTPException(400, f"Invalid BPMN XML: {exc}")

        safe_name = "".join(c for c in body.name if c.isalnum() or c in "_-")
        if not safe_name:
            safe_name = "workflow"
        target_dir = Path("workflows")
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / f"{safe_name}.bpmn"
        await asyncio.to_thread(target_path.write_text, body.xml, encoding="utf-8")
        return {"path": str(target_path), "process_ids": parser.get_process_ids()}

    # Webhooks & Event Notifications (TODO 03)
    @app.post("/api/webhooks", tags=["Webhooks"], summary="Register an HTTP webhook subscription")
    async def register_webhook(
        body: WebhookRegistration,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        return get_service().store.register_webhook(str(body.url), body.events)

    @app.get("/api/webhooks", tags=["Webhooks"], summary="List registered webhooks")
    async def list_webhooks(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().store.list_webhooks()

    @app.delete("/api/webhooks/{webhook_id}", response_model=DeleteWebhookResponse, tags=["Webhooks"], summary="Delete a registered webhook")
    async def delete_webhook(
        webhook_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, bool]:
        if not get_service().store.delete_webhook(webhook_id):
            raise HTTPException(404, "webhook not found")
        return {"deleted": True}

    @app.get("/instance/{workflow_id}/events", tags=["Instance"], summary="Get audit event log for workflow")
    async def instance_events(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().store.get_events(workflow_id)

    # History API
    @app.get("/api/history/storage", response_model=StorageStats, tags=["History"], summary="Get ZODB storage statistics")
    async def api_history_storage(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        return await get_service().storage_stats()

    @app.post("/api/history/pack", response_model=PackResult, tags=["History"], summary="Pack and compact ZODB database")
    async def api_history_pack(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        return await get_service().pack_database()

    @app.get("/api/history/instances", response_model=list[WorkflowState], tags=["History"], summary="List historical workflow instances")
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

    @app.delete("/api/history/instances/{workflow_id}", response_model=DeleteInstanceResponse, tags=["History"], summary="Delete historical workflow instance")
    async def delete_history_instance(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if not await get_service().delete_instance(workflow_id):
            raise HTTPException(404, "workflow not found")
        return {"deleted": workflow_id}

    @app.delete("/api/history/instances", response_model=ClearInstancesResponse, tags=["History"], summary="Clear all history instances")
    async def clear_history_instances(
        confirm: str = "",
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if confirm != "DELETE_ALL":
            raise HTTPException(400, "confirm=DELETE_ALL is required")
        return {"deleted": await get_service().clear_instances()}

    # Admin endpoints
    @app.get("/admin/instances", response_model=list[WorkflowState], tags=["Admin"], summary="List instances for admin")
    async def admin_instances(
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> list[dict[str, Any]]:
        return get_service().instances()

    @app.post("/admin/pack", response_model=PackResult, tags=["Admin"], summary="Admin pack database", deprecated=True)
    async def admin_pack(
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, Any]:
        return await api_history_pack(role=role)

    @app.delete("/admin/instances/{workflow_id}", response_model=DeleteInstanceResponse, tags=["Admin"], summary="Admin delete instance")
    async def delete_instance(
        workflow_id: str,
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if not await get_service().delete_instance(workflow_id):
            raise HTTPException(404, "workflow not found")
        return {"deleted": workflow_id}

    @app.delete("/admin/instances", response_model=ClearInstancesResponse, tags=["Admin"], summary="Admin clear all instances")
    async def clear_instances(
        confirm: str = "",
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if confirm != "DELETE_ALL":
            raise HTTPException(400, "confirm=DELETE_ALL is required")
        return {"deleted": await get_service().clear_instances()}

    # Instance endpoints
    @app.get("/instance/{workflow_id}/savepoint/{save_point_id}", tags=["Instance"], summary="Get savepoint detail")
    async def get_savepoint_detail(
        workflow_id: str,
        save_point_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().save_point_detail(workflow_id, save_point_id)
        except (WorkflowNotFound, KeyError) as exc:
            raise HTTPException(404, f"save point not found: {exc.args[0]}")

    @app.get("/instance/{workflow_id}/state", response_model=WorkflowState, tags=["Instance"], summary="Get instance state")
    async def instance_state(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().state(workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

    @app.get("/instance/{workflow_id}/diagram", response_class=PlainTextResponse, tags=["Instance"], summary="Get instance BPMN diagram")
    async def instance_diagram(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> PlainTextResponse:
        try:
            return PlainTextResponse(await get_service().diagram(workflow_id), media_type="application/xml")
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")
        except FileNotFoundError:
            raise HTTPException(404, "BPMN diagram not found")

    @app.get("/instance/{workflow_id}/workspace", tags=["Instance"], summary="Download instance workspace")
    async def download_workspace(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

        workspace_obj = get_service().store.get_workspace(workflow_id)
        
        if workspace_obj is None:
            import tempfile
            from app.workspace import cleanup_workspace, pack_workspace_to_bytes
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

    @app.get("/instance/{workflow_id}/workspace/files", tags=["Instance"], summary="Get workspace file metadata manifest")
    async def instance_workspace_files(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            get_service().state(workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

        meta = get_service().store.get_workspace_metadata(workflow_id)
        return meta or {"file_count": 0, "total_size": 0, "files": [], "artifacts": []}

    @app.get("/instance/{workflow_id}/workspace/file", tags=["Instance"], summary="Extract and view single workspace file")
    async def instance_workspace_file(
        workflow_id: str,
        path: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> Response:
        try:
            get_service().state(workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

        workspace_obj = get_service().store.get_workspace(workflow_id)
        if not workspace_obj:
            raise HTTPException(404, "workspace is empty")

        from app.workspace import extract_workspace_file
        file_bytes = await extract_workspace_file(workspace_obj, path)
        if file_bytes is None:
            raise HTTPException(404, f"file not found in workspace: {path}")

        import mimetypes
        media_type, _ = mimetypes.guess_type(path)
        return Response(
            content=file_bytes,
            media_type=media_type or "application/octet-stream",
            headers={"Content-Disposition": f'inline; filename="{Path(path).name}"'},
        )

    @app.get("/instance/{workflow_id}/form/{task_id}", tags=["Instance"], summary="Get FormJS schema for task")
    async def instance_form(
        workflow_id: str,
        task_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().form(workflow_id, task_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")
        except (KeyError, ValueError) as exc:
            raise HTTPException(409, str(exc))

    @app.post("/instance/{workflow_id}/fork/{save_point_id}", response_model=WorkflowState, tags=["Instance"], summary="Fork workflow from savepoint")
    async def fork_instance(
        workflow_id: str,
        save_point_id: str,
        request: ForkRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().fork(workflow_id, save_point_id, request.variables)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")
        except KeyError as exc:
            raise HTTPException(404, f"save point not found: {exc.args[0]}")
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @app.post("/instance/{workflow_id}/submit-task/{task_id}", response_model=WorkflowState, tags=["Instance"], summary="Submit user task")
    async def instance_submit_task(
        workflow_id: str,
        task_id: str,
        request: SubmitTaskRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().submit_task(workflow_id, task_id, request.variables)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")
        except (KeyError, ValueError) as exc:
            raise HTTPException(409, str(exc))

    @app.post("/instance/{workflow_id}/retry/{task_id}", response_model=WorkflowState, tags=["Instance"], summary="Retry failed service task")
    async def retry_instance_task(
        workflow_id: str,
        task_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().retry_task(workflow_id, task_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")
        except (KeyError, ValueError) as exc:
            raise HTTPException(409, str(exc))

    @app.post("/instance/{workflow_id}/cancel", response_model=WorkflowState, tags=["Instance"], summary="Cancel running workflow instance")
    async def cancel_instance(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().cancel(workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")
        except KeyError:
            raise HTTPException(404, "workflow not found")

    @app.get("/instance/{workflow_id}/events/stream", tags=["Instance"], summary="Stream instance events via SSE")
    async def sse_events_stream(
        workflow_id: str,
        request: Request,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> StreamingResponse:
        svc = get_service()
        try:
            svc.state(workflow_id)
        except (WorkflowNotFound, KeyError):
            raise HTTPException(404, "workflow not found")

        import json

        async def event_generator():
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

    @app.get("/metrics", response_class=PlainTextResponse, tags=["Observability"], summary="Prometheus metrics")
    async def prometheus_metrics() -> PlainTextResponse:
        svc = get_service()
        stats = svc.store.storage_stats()
        meta = svc.store.list_metadata()
        active = sum(1 for m in meta if m.get("status") in ("waiting_pi", "waiting_human", "running"))
        completed = sum(1 for m in meta if m.get("status") == "completed")
        failed = sum(1 for m in meta if m.get("status") == "failed")
        cancelled = sum(1 for m in meta if m.get("status") == "cancelled")
        total = len(meta)
        zodb_bytes = stats.get("data_fs_size_bytes", 0)

        lines = [
            "# HELP bpmn_instances_total Total workflow instances by status",
            "# TYPE bpmn_instances_total gauge",
            f'bpmn_instances_total{{status="active"}} {active}',
            f'bpmn_instances_total{{status="completed"}} {completed}',
            f'bpmn_instances_total{{status="failed"}} {failed}',
            f'bpmn_instances_total{{status="cancelled"}} {cancelled}',
            f'bpmn_instances_total{{status="all"}} {total}',
            "# HELP bpmn_zodb_storage_bytes ZODB storage size in bytes",
            "# TYPE bpmn_zodb_storage_bytes gauge",
            f"bpmn_zodb_storage_bytes {zodb_bytes}",
            "# HELP bpmn_active_background_jobs Active background worker jobs",
            "# TYPE bpmn_active_background_jobs gauge",
            f"bpmn_active_background_jobs {len(svc.jobs)}",
        ]
        return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")

    # Workflow API
    @app.post("/workflow/start", response_model=WorkflowState, tags=["Workflow"], summary="Start a new workflow instance")
    async def start(
        request: StartWorkflowRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        try:
            return await get_service().start(request.bpmn_path, request.process_id, request.variables)
        except FileNotFoundError:
            raise HTTPException(404, "BPMN file not found")

    @app.get("/workflow/{workflow_id}/state", response_model=WorkflowState, tags=["Workflow"], summary="Get workflow execution state")
    async def state(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().state(workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

    @app.post("/workflow/{workflow_id}/submit-task/{task_id}", response_model=WorkflowState, tags=["Workflow"], summary="Submit human task by ID", deprecated=True)
    async def submit_task(
        workflow_id: str,
        task_id: str,
        request: SubmitTaskRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        return await instance_submit_task(workflow_id, task_id, request, role)

    @app.post("/workflow/{workflow_id}/submit-task", response_model=WorkflowState, tags=["Workflow"], summary="Submit human task via JSON body")
    async def submit_task_body(
        workflow_id: str,
        request: SubmitTaskRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        if not request.task_id:
            raise HTTPException(422, "task_id is required")
        return await submit_task(workflow_id, request.task_id, request, role)

    @app.get("/workflow/{workflow_id}/form/{task_id}", tags=["Workflow"], summary="Get FormJS schema for task")
    async def form(
        workflow_id: str,
        task_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().form(workflow_id, task_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")
        except (KeyError, ValueError) as exc:
            raise HTTPException(409, str(exc))

    return app


app = create_app()
