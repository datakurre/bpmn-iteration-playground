import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from bpmn_agent.agents_root import Workspace
from bpmn_agent.api.routers import (
    admin,
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
from bpmn_agent.api.security import OriginHostGuardMiddleware
from bpmn_agent.element_templates_registry import ElementTemplatesRegistry
from bpmn_agent.logging_config import RequestLoggingMiddleware, configure_logging
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.projects import ProjectService
from bpmn_agent.registry import WorkflowRegistry
from bpmn_agent.workflow_service import WorkflowService

logger = logging.getLogger("bpmn.api")
configure_logging()


def create_app(service: WorkflowService | None = None, workspace: Workspace | None = None) -> FastAPI:
    """Build the FastAPI app.

    `workspace` only matters when `service` is omitted -- it decides where a *default*
    WorkflowService's ZODB store lives: `<workspace>/.agents/state/Data.fs` rather than
    the bare `data/workflows.fs` this used to hard-code. It defaults to `Workspace.discover()`
    (CWD, walking up for an existing `.agents/` or `.git/`) so `create_app()` still works
    with zero setup, the same as before. Passing an explicit `service` (as every test does)
    bypasses this entirely -- state was still injected outside this function.

    The template registry stays on `WorkflowRegistry()`'s own default (this package's
    bundled templates, see registry.py) rather than `workspace.workflows_dir` -- wiring the
    live registry to the workspace's *editable* copy `bpmn init` materialises is deliberately
    not done yet, so that a plain `bpmn serve` with no `bpmn init` step still has templates
    to list.
    """
    _service = service
    _workspace = workspace or Workspace.discover()
    template_registry = WorkflowRegistry()
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
        try:
            svc = get_service()
            recovered = await svc.recover_orphaned_workflows()
            if recovered:
                logger.info(f"Startup recovery cleaned up {recovered} orphaned workflows")
        except Exception as exc:
            logger.warning(f"Startup recovery check failed: {exc}")
        try:
            get_service().start_timer_loop()
        except Exception as exc:
            logger.warning(f"Failed to start timer loop: {exc}")
        try:
            yield
        finally:
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
            {"name": "Admin", "description": "Administrative maintenance and storage compaction"},
        ],
    )

    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(OriginHostGuardMiddleware)

    bpmn_assets = Path(__file__).resolve().parents[2] / "node_modules" / "bpmn-js" / "dist"
    form_assets = Path(__file__).resolve().parents[2] / "node_modules" / "@bpmn-io" / "form-js" / "dist"
    app_static = Path(__file__).resolve().parents[1] / "static"
    if app_static.is_dir():
        app.mount("/static/app", StaticFiles(directory=app_static), name="app-static")
    if form_assets.is_dir():
        app.mount("/static/form-js", StaticFiles(directory=form_assets), name="form-static")
    if bpmn_assets.is_dir():
        app.mount("/static", StaticFiles(directory=bpmn_assets), name="static")

    app.include_router(system.build_router(get_service))
    app.include_router(pages.build_router(get_service))
    app.include_router(websocket.build_router(get_service))
    app.include_router(templates.build_router(get_service, template_registry, element_templates_registry))
    app.include_router(webhooks.build_router(get_service))
    app.include_router(history.build_router(get_service))
    app.include_router(admin.build_router(get_service))
    app.include_router(instance.build_router(get_service))
    app.include_router(workflow.build_router(get_service))
    app.include_router(projects.build_router(get_project_service))

    return app


app = create_app()
