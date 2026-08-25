"""Health check and Prometheus metrics -- no auth-role-specific business logic."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from bpmn_agent.auth import Role, require_role
from bpmn_agent.workflow_service import WorkflowService


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.get("/health", tags=["System"], summary="Health check endpoint")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/metrics", response_class=PlainTextResponse, tags=["Observability"], summary="Prometheus metrics")
    async def prometheus_metrics(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> PlainTextResponse:
        svc = get_service()
        stats = await svc.storage_stats()
        meta = svc.history_instances()
        active = sum(1 for m in meta if m.get("status") in ("waiting_pi", "waiting_human", "running"))
        completed = sum(1 for m in meta if m.get("status") == "completed")
        failed = sum(1 for m in meta if m.get("status") == "failed")
        cancelled = sum(1 for m in meta if m.get("status") == "cancelled")
        total = len(meta)
        zodb_bytes = stats.get("size_bytes", 0)

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

    return router
