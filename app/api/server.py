import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.api.ui import admin_page, editor_page, history_detail_page, history_page, instance_page, page
from app.auth import Role, require_role
from app.logging_config import RequestLoggingMiddleware, configure_logging
from app.models import (
    AdminCleanupRequest,
    ForkRequest,
    PackResult,
    SavePointSummary,
    StartWorkflowRequest,
    StorageStats,
    SubmitTaskRequest,
    WebhookRegistration,
    WorkflowState,
)
from app.persistence import WorkflowStore
from app.registry import WorkflowRegistry
from app.workflow_service import WorkflowNotFound, WorkflowService
from app.ws import manager as ws_manager

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
    async def dashboard(request: Request) -> Response:
        return page(request)

    @app.get("/history", response_class=HTMLResponse, tags=["UI"], summary="Execution History UI")
    async def history_ui(request: Request) -> Response:
        return history_page(request)

    @app.get("/history/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Historical Instance Detail UI")
    async def history_detail_ui(request: Request, workflow_id: str) -> Response:
        try:
            get_service().state(workflow_id)
            return history_detail_page(request, workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

    @app.get("/admin", response_class=HTMLResponse, tags=["UI"], summary="Administrative Panel UI")
    async def admin(request: Request) -> Response:
        return admin_page(request)

    @app.get("/editor", response_class=HTMLResponse, tags=["UI"], summary="BPMN Modeler Editor UI")
    async def editor_ui(request: Request) -> Response:
        return editor_page(request)

    @app.get("/instance/{workflow_id}", response_class=HTMLResponse, tags=["UI"], summary="Live Workflow Instance View")
    async def instance(request: Request, workflow_id: str) -> Response:
        try:
            get_service().state(workflow_id)
            return instance_page(request, workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

    # WebSocket Real-Time Updates (TODO 12)
    @app.websocket("/ws/instance/{workflow_id}")
    async def ws_instance(websocket: WebSocket, workflow_id: str) -> None:
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
    @app.get("/api/templates", tags=["Templates"], summary="List available BPMN templates")
    async def list_templates() -> list[dict[str, Any]]:
        return [t.to_dict() for t in registry.list_templates()]

    @app.get("/api/templates/{process_id}", tags=["Templates"], summary="Get template metadata")
    async def get_template(process_id: str) -> dict[str, Any]:
        template = registry.get_template(process_id)
        if not template:
            raise HTTPException(404, "template not found")
        return template.to_dict()

    @app.get("/api/templates/{process_id}/xml", response_class=PlainTextResponse, tags=["Templates"], summary="Get template raw BPMN XML")
    async def get_template_xml(process_id: str) -> PlainTextResponse:
        template = registry.get_template(process_id)
        if not template:
            raise HTTPException(404, "template not found")
        path = Path(template.path)
        if not path.is_file():
            raise HTTPException(404, "template file not found")
        return PlainTextResponse(path.read_text(encoding="utf-8"), media_type="application/xml")

    # Workflow Save Endpoint (TODO 20)
    @app.post("/api/workflows/save", tags=["Templates"], summary="Save or update BPMN XML file")
    async def save_workflow(
        body: SaveWorkflowRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        import io
        from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser

        parser = BpmnParser()
        try:
            parser.add_bpmn_io(io.BytesIO(body.xml.encode("utf-8")))
        except Exception as exc:
            raise HTTPException(400, f"Invalid BPMN XML: {exc}")

        safe_name = "".join(c for c in body.name if c.isalnum() or c in "_-")
        if not safe_name:
            safe_name = "workflow"
        target_dir = Path("workflows")
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / f"{safe_name}.bpmn"
        target_path.write_text(body.xml, encoding="utf-8")
        return {"path": str(target_path), "process_ids": parser.get_process_ids()}

    # Webhooks & Event Notifications (TODO 03)
    @app.post("/api/webhooks", tags=["Webhooks"], summary="Register an HTTP webhook subscription")
    async def register_webhook(
        body: WebhookRegistration,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        return get_service().store.register_webhook(body.url, body.events)

    @app.get("/api/webhooks", tags=["Webhooks"], summary="List registered webhooks")
    async def list_webhooks(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().store.list_webhooks()

    @app.delete("/api/webhooks/{webhook_id}", tags=["Webhooks"], summary="Delete a registered webhook")
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

    @app.get("/api/history/instances", tags=["History"], summary="List historical workflow instances")
    async def api_history_instances(
        status: str | None = None,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().history_instances(status_filter=status)

    @app.delete("/api/history/instances/{workflow_id}", tags=["History"], summary="Delete historical workflow instance")
    async def delete_history_instance(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if not get_service().delete_instance(workflow_id):
            raise HTTPException(404, "workflow not found")
        return {"deleted": workflow_id}

    @app.delete("/api/history/instances", tags=["History"], summary="Clear all history instances")
    async def clear_history_instances(
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        return {"deleted": get_service().clear_instances()}

    # Admin endpoints
    @app.get("/admin/instances", tags=["Admin"], summary="List instances for admin")
    async def admin_instances(
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> list[dict[str, Any]]:
        return get_service().instances()

    @app.post("/admin/pack", response_model=PackResult, tags=["Admin"], summary="Admin pack database")
    async def admin_pack(
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, Any]:
        return await get_service().pack_database()

    @app.delete("/admin/instances/{workflow_id}", tags=["Admin"], summary="Admin delete instance")
    async def delete_instance(
        workflow_id: str,
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if not get_service().delete_instance(workflow_id):
            raise HTTPException(404, "workflow not found")
        return {"deleted": workflow_id}

    @app.delete("/admin/instances", tags=["Admin"], summary="Admin clear all instances")
    async def clear_instances(
        confirm: str = "",
        x_admin_token: str | None = Header(default=None),
        role: Role = require_role(Role.ADMIN),
    ) -> dict[str, object]:
        if confirm != "DELETE_ALL":
            raise HTTPException(400, "confirm=DELETE_ALL is required")
        return {"deleted": get_service().clear_instances()}

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
            return PlainTextResponse(get_service().diagram(workflow_id), media_type="application/xml")
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

    # Workflow API
    @app.post("/workflow/start", response_model=WorkflowState, tags=["Workflow"], summary="Start a new workflow instance")
    async def start(
        request: StartWorkflowRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        return await get_service().start(request.bpmn_path, request.process_id, request.variables)

    @app.get("/workflow/{workflow_id}/state", response_model=WorkflowState, tags=["Workflow"], summary="Get workflow execution state")
    async def state(
        workflow_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        try:
            return get_service().state(workflow_id)
        except WorkflowNotFound:
            raise HTTPException(404, "workflow not found")

    @app.post("/workflow/{workflow_id}/submit-task/{task_id}", response_model=WorkflowState, tags=["Workflow"], summary="Submit human task by ID")
    async def submit_task(
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
