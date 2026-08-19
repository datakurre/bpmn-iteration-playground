from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional


@dataclass
class WorkflowTemplate:
    id: str
    name: str
    path: str
    description: str = ""
    category: str = "general"
    variables: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "path": self.path,
            "description": self.description,
            "category": self.category,
            "variables": list(self.variables),
        }


class WorkflowRegistry:
    """Registry discovering and inspecting executable BPMN workflow templates in the repository."""

    def __init__(self, workflows_dir: str = "workflows") -> None:
        self.dir = Path(workflows_dir)

    def list_templates(self) -> List[WorkflowTemplate]:
        templates: list[WorkflowTemplate] = []
        if not self.dir.exists():
            return templates

        for bpmn_file in sorted(self.dir.glob("*.bpmn")):
            try:
                template = self._parse_template(bpmn_file)
                if template is not None:
                    templates.append(template)
            except Exception:
                continue
        return templates

    def get_template(self, process_id: str) -> Optional[WorkflowTemplate]:
        for template in self.list_templates():
            if template.id == process_id or Path(template.path).stem == process_id:
                return template
        return None

    def _parse_template(self, path: Path) -> Optional[WorkflowTemplate]:
        root = ET.parse(path).getroot()
        ns = {"bpmn": "http://www.omg.org/spec/BPMN/20100524/MODEL"}
        process = root.find(".//bpmn:process[@isExecutable='true']", ns)
        if process is None:
            # Fallback to any process
            process = root.find(".//bpmn:process", ns)
        if process is None:
            return None

        doc = process.find("bpmn:documentation", ns)
        description = doc.text.strip() if doc is not None and doc.text else ""

        process_id = process.get("id", path.stem)
        name = process.get("name", path.stem.replace("_", " ").title())

        return WorkflowTemplate(
            id=process_id,
            name=name,
            path=str(path),
            description=description,
        )
