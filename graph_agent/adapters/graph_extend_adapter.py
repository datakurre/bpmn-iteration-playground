from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

from graph_agent.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter

logger = logging.getLogger("bpmn.adapters.graph_extend")


class GraphExtendAdapter(BaseAdapter):
    """Applies the agent's extension_spec to the running workflow."""

    def __init__(self, service: Any = None) -> None:
        self.service = service

    @property
    def adapter_type(self) -> str:
        return "graph_extend"

    @property
    def capabilities(self) -> AdapterCapabilities:
        return AdapterCapabilities(display_name="Graph Extend", supports_sessions=False)

    async def run(
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
        on_event: Any = None,
    ) -> AgentResult:
        prompt_data: dict[str, Any] = {}
        idx = prompt.find("{")
        if idx != -1:
            with contextlib.suppress(Exception):
                prompt_data = json.loads(prompt[idx:])

        vars_dict = prompt_data.get("variables", {})
        extension_spec = vars_dict.get("extension_spec")
        if isinstance(extension_spec, str):
            with contextlib.suppress(Exception):
                extension_spec = json.loads(extension_spec)

        if isinstance(extension_spec, list) and extension_spec:
            extension_spec = extension_spec[0]

        if not extension_spec:
            return AgentResult(
                status="failed",
                output=None,
                text="No extension_spec found in task variables",
                stderr="No extension_spec found in task variables",
            )

        from graph_agent.models import ExtendRequest

        try:
            req = ExtendRequest.model_validate(extension_spec)
        except Exception as exc:
            return AgentResult(
                status="failed",
                output=None,
                text=f"Invalid extension_spec: {exc}",
                stderr=f"Invalid extension_spec: {exc}",
            )

        workflow_id = config.get("workflow_id") or prompt_data.get("workflow_id")
        if not workflow_id:
            return AgentResult(
                status="failed",
                output=None,
                text="Missing workflow_id",
                stderr="Missing workflow_id",
            )

        if self.service is not None:
            try:
                result = await self.service.extend_graph(workflow_id, req)
                return AgentResult(
                    status="success",
                    output={
                        "status": "success",
                        "summary": f"Inserted {len(result.get('inserted_nodes', []))} nodes into graph",
                        "findings": [],
                        "artifacts": [],
                        "next_action": "continue",
                    },
                    text="Graph extended successfully",
                )
            except Exception as exc:
                return AgentResult(
                    status="failed",
                    output=None,
                    text=f"Failed to extend graph: {exc}",
                    stderr=f"Failed to extend graph: {exc}",
                )

        return AgentResult(
            status="success",
            output={
                "status": "success",
                "summary": "Graph extend completed",
                "findings": [],
                "artifacts": [],
                "next_action": "continue",
            },
            text="Graph extend completed",
        )
