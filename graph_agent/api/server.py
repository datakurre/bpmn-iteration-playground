import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from graph_agent.agents_root import Workspace
from graph_agent.api.routers import (
    history,
    instance,
    pages,
    projects,
    system,
    templates,
    webhooks,
    websocket,
    workflow,
)
from graph_agent.api.security import OriginHostGuardMiddleware
from graph_agent.daemon import (
    RUNTIME_SCHEMA_VERSION,
    RuntimeInfo,
    is_daemon_alive,
    read_runtime_file,
    remove_runtime_file,
    write_runtime_file,
)
from graph_agent.element_templates_registry import ElementTemplatesRegistry
from graph_agent.logging_config import RequestLoggingMiddleware, configure_logging
from graph_agent.persistence import WorkflowStore
from graph_agent.projects import ProjectService
from graph_agent.registry import WorkflowRegistry
from graph_agent.workflow_service import WorkflowService

logger = logging.getLogger("bpmn.api")
configure_logging()


def _register_runtime_if_needed(workspace: Workspace) -> bool:
    try:
        existing = read_runtime_file(workspace)
        if existing is not None and existing.pid != os.getpid() and is_daemon_alive(existing, check_http=True):
            return False
        port = int(os.getenv("PORT", "8080"))
        host = os.getenv("HOST", "127.0.0.1")
        url_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
        token = os.getenv("ADMIN_TOKEN", "")
        info = RuntimeInfo(
            schema=RUNTIME_SCHEMA_VERSION,
            pid=os.getpid(),
            port=port,
            url=f"http://{url_host}:{port}",
            token=token,
            started_at=datetime.now(UTC).isoformat(),
        )
        write_runtime_file(workspace, info)
        return True
    except Exception as exc:
        logger.warning(f"Could not register runtime info: {exc}")
    return False


def _mount_static_files(app: FastAPI) -> None:
    app_static = Path(__file__).resolve().parents[1] / "static"

    # Specific static mounts must precede the general /static prefix mount.
    # Check graph_agent/static/vendor first (self-contained package), fallback to node_modules (dev repo).
    form_assets = app_static / "vendor" / "form-js"
    if not form_assets.is_dir():
        form_assets = Path(__file__).resolve().parents[2] / "node_modules" / "@bpmn-io" / "form-js" / "dist"

    bpmn_assets = app_static / "vendor" / "bpmn-js"
    if not bpmn_assets.is_dir():
        bpmn_assets = Path(__file__).resolve().parents[2] / "node_modules" / "bpmn-js" / "dist"

    if form_assets.is_dir():
        app.mount("/static/form-js", StaticFiles(directory=form_assets), name="form-static")
    if app_static.is_dir():
        app.mount("/static/app", StaticFiles(directory=app_static), name="app-static")
    if bpmn_assets.is_dir():
        app.mount("/static", StaticFiles(directory=bpmn_assets), name="static")


def create_app(service: WorkflowService | None = None, workspace: Workspace | None = None) -> FastAPI:
    """Build the FastAPI app.

    `workspace` only matters when `service` is omitted -- it decides where a *default*
    WorkflowService's ZODB store lives: `<workspace.state_dir>/Data.fs` (user local
    XDG_CONFIG_HOME/graph-agent, ~/.config/graph-agent). Passing an explicit `service`
    (as every test does) bypasses this entirely -- state was still injected outside this function.

    The template registry defaults to `workspace.models_dir` (if present) or this package's
    bundled models (see registry.py).
    """
    _service = service
    _workspace = workspace or Workspace.discover()
    models_dir = _workspace.models_dir
    template_registry = WorkflowRegistry(
        models_dir=models_dir if (models_dir.exists() and any(models_dir.glob("*.bpmn"))) else None
    )
    element_templates_registry = ElementTemplatesRegistry()
    _project_service: ProjectService | None = None

    def get_service() -> WorkflowService:
        nonlocal _service
        if _service is None:
            _workspace.ensure()
            _service = WorkflowService(WorkflowStore(str(_workspace.state_dir / "Data.fs")), workspace=_workspace)
        return _service

    def get_project_service() -> ProjectService:
        nonlocal _project_service
        if _project_service is None:
            _project_service = ProjectService(get_service(), template_registry)
        return _project_service

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging(os.getenv("LOG_LEVEL", "INFO"))
        runtime_written = _register_runtime_if_needed(_workspace)

        try:
            svc = get_service()
            recovered = await svc.recover_orphaned_workflows()
            if recovered:
                logger.info(f"Startup recovery cleaned up {recovered} orphaned workflows")
            resumed = await svc.resume_pending_workflows()
            if resumed:
                logger.info(f"Startup resumed {resumed} workflows with pending tasks")
        except Exception as exc:
            logger.warning(f"Startup recovery check failed: {exc}")
        try:
            get_service().start_timer_loop()
        except Exception as exc:
            logger.warning(f"Failed to start timer loop: {exc}")
        try:
            yield
        finally:
            if runtime_written:
                with suppress(Exception):
                    remove_runtime_file(_workspace)
            with suppress(Exception):
                await get_service().shutdown()
            with suppress(Exception):
                await get_service().stop_timer_loop()

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
            {"name": "Projects", "description": "Long-running Projects: create, list, and spawn child tasks"},
        ],
    )

    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(OriginHostGuardMiddleware)

    _mount_static_files(app)

    app.include_router(system.build_router(get_service))
    app.include_router(pages.build_router(get_service))
    app.include_router(websocket.build_router(get_service))
    app.include_router(templates.build_router(get_service, template_registry, element_templates_registry))
    app.include_router(webhooks.build_router(get_service))
    app.include_router(history.build_router(get_service))
    app.include_router(instance.build_router(get_service))
    app.include_router(workflow.build_router(get_service))
    app.include_router(projects.build_router(get_project_service))

    return app


app = create_app()
