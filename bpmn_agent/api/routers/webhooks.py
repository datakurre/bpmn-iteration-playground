"""Webhook subscription management."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException

from bpmn_agent.auth import Role, require_role
from bpmn_agent.models import DeleteWebhookResponse, WebhookRegistration
from bpmn_agent.workflow_service import WorkflowService


def build_router(get_service: Callable[[], WorkflowService]) -> APIRouter:
    router = APIRouter()

    @router.post("/api/webhooks", tags=["Webhooks"], summary="Register an HTTP webhook subscription")
    async def register_webhook(
        body: WebhookRegistration,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        return get_service().register_webhook(str(body.url), body.events)

    @router.get("/api/webhooks", tags=["Webhooks"], summary="List registered webhooks")
    async def list_webhooks(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return get_service().list_webhooks()

    @router.delete("/api/webhooks/{webhook_id}", response_model=DeleteWebhookResponse, tags=["Webhooks"], summary="Delete a registered webhook")
    async def delete_webhook(
        webhook_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, bool]:
        if not get_service().delete_webhook(webhook_id):
            raise HTTPException(404, "webhook not found")
        return {"deleted": True}

    return router
