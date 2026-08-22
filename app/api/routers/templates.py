"""Harness/template discovery, and saving hand-authored BPMN XML to workflows/."""

from __future__ import annotations

import asyncio
import io
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from app.auth import Role, require_role
from app.element_templates_registry import ElementTemplatesRegistry
from app.models import HarnessSummary, SaveWorkflowRequest, SaveWorkflowResponse, TemplateSummary
from app.registry import WorkflowRegistry
from app.workflow_service import WorkflowService
from app.xml_utils import safe_fromstring_xml


def build_router(
    get_service: Callable[[], WorkflowService],
    template_registry: WorkflowRegistry,
    element_templates_registry: ElementTemplatesRegistry | None = None,
) -> APIRouter:
    router = APIRouter()
    et_registry = element_templates_registry or ElementTemplatesRegistry()

    @router.get(
        "/api/element-templates",
        response_model=list[dict[str, Any]],
        tags=["Templates"],
        summary="List bpmn-js element templates for the modeler's template chooser",
    )
    async def list_element_templates(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return et_registry.list_templates()

    @router.get("/api/harnesses", response_model=list[HarnessSummary], tags=["Templates"], summary="List registered harness types")
    async def list_harnesses(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        adapter_registry = get_service().registry
        harnesses = []
        for harness_type in sorted(adapter_registry.list_types()):
            adapter = adapter_registry.get(harness_type)
            if adapter is None:
                continue
            caps = adapter.capabilities
            harnesses.append({
                "harness_type": harness_type,
                "display_name": caps.display_name,
                "supports_sessions": caps.supports_sessions,
                "consumes_prompt": caps.consumes_prompt,
                "view": caps.view,
            })
        return harnesses

    @router.get("/api/templates", response_model=list[TemplateSummary], tags=["Templates"], summary="List available BPMN templates")
    async def list_templates(
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> list[dict[str, Any]]:
        return [t.to_dict() for t in template_registry.list_templates()]

    @router.get("/api/templates/{process_id}", response_model=TemplateSummary, tags=["Templates"], summary="Get template metadata")
    async def get_template(
        process_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> dict[str, Any]:
        template = template_registry.get_template(process_id)
        if not template:
            raise HTTPException(404, "template not found")
        return template.to_dict()

    @router.get("/api/templates/{process_id}/xml", response_class=PlainTextResponse, tags=["Templates"], summary="Get template raw BPMN XML")
    async def get_template_xml(
        process_id: str,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR, Role.VIEWER),
    ) -> PlainTextResponse:
        template = template_registry.get_template(process_id)
        if not template:
            raise HTTPException(404, "template not found")
        path = Path(template.path)
        if not path.is_file():
            raise HTTPException(404, "template file not found")
        return PlainTextResponse(await asyncio.to_thread(path.read_text, encoding="utf-8"), media_type="application/xml")

    @router.post("/api/workflows/save", response_model=SaveWorkflowResponse, tags=["Templates"], summary="Save or update BPMN XML file")
    async def save_workflow(
        body: SaveWorkflowRequest,
        role: Role = require_role(Role.ADMIN, Role.OPERATOR),
    ) -> dict[str, Any]:
        from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser

        parser = BpmnParser()
        try:
            safe_fromstring_xml(body.xml)
            parser.add_bpmn_io(io.BytesIO(body.xml.encode("utf-8")))
        except Exception as exc:
            raise HTTPException(400, f"Invalid BPMN XML: {exc}") from exc

        safe_name = "".join(c for c in body.name if c.isalnum() or c in "_-")
        if not safe_name:
            safe_name = "workflow"
        target_dir = Path("workflows")
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / f"{safe_name}.bpmn"
        await asyncio.to_thread(target_path.write_text, body.xml, encoding="utf-8")
        return {"path": str(target_path), "process_ids": parser.get_process_ids()}

    return router
