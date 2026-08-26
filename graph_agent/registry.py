import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graph_agent.xml_utils import safe_parse_xml

logger = logging.getLogger("bpmn.registry")


@dataclass
class WorkflowTemplate:
    id: str
    name: str
    path: str
    description: str = ""
    category: str = "general"
    variables: list[dict[str, Any]] = field(default_factory=list)
    is_project: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "path": self.path,
            "description": self.description,
            "category": self.category,
            "variables": list(self.variables),
            "is_project": self.is_project,
        }


# The bundled templates ship as package data (graph_agent/data/workflows/) and in models/
# so a `WorkflowRegistry()` default finds real templates when this package is installed or run locally.
BUNDLED_WORKFLOWS_DIR = Path(__file__).resolve().parent / "data" / "workflows"
BUNDLED_MODELS_DIR = (
    BUNDLED_WORKFLOWS_DIR
    if BUNDLED_WORKFLOWS_DIR.exists()
    else (Path(__file__).resolve().parents[1] / "models")
)


class WorkflowRegistry:
    """Registry discovering and inspecting executable BPMN workflow models / templates."""

    def __init__(
        self,
        models_dir: str | Path | None = None,
        workflows_dir: str | Path | None = None,
    ) -> None:
        chosen = models_dir or workflows_dir
        self.dir = Path(chosen) if chosen is not None else BUNDLED_MODELS_DIR
        self._cache: dict[str, tuple[float, WorkflowTemplate | None]] = {}

    def list_templates(self) -> list[WorkflowTemplate]:
        templates: list[WorkflowTemplate] = []
        if not self.dir.exists():
            return templates

        current_paths: set[str] = set()
        for bpmn_file in sorted(self.dir.glob("*.bpmn")):
            file_key = str(bpmn_file)
            current_paths.add(file_key)
            try:
                mtime = bpmn_file.stat().st_mtime
                if file_key in self._cache and self._cache[file_key][0] == mtime:
                    cached_template = self._cache[file_key][1]
                    if cached_template is not None:
                        templates.append(cached_template)
                    continue

                template = self._parse_template(bpmn_file)
                self._cache[file_key] = (mtime, template)
                if template is not None:
                    templates.append(template)
            except Exception as exc:
                logger.warning("Failed to parse BPMN template %s: %s", bpmn_file, exc, exc_info=True)
                continue

        # Evict deleted files from cache
        stale_keys = [k for k in self._cache if k not in current_paths]
        for k in stale_keys:
            self._cache.pop(k, None)

        return templates

    def get_template(self, process_id: str) -> WorkflowTemplate | None:
        for template in self.list_templates():
            if template.id == process_id or Path(template.path).stem == process_id:
                return template
        return None

    def _parse_template(self, path: Path) -> WorkflowTemplate | None:
        root = safe_parse_xml(path).getroot()
        if root is None:
            return None
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
            is_project=self._declares_project(process, ns),
        )

    @staticmethod
    def _declares_project(process: Any, ns: dict[str, str]) -> bool:
        """Whether this process declares itself a Project template.

        A Project is convention, not a record (see plans/concepts.md "Project identity is
        convention, not a record"): the process opts in with a process-level
        ``camunda:property name="project"``. Read only from the process element's own
        extensions -- a task inside the process carrying the same property must not make the
        whole template a Project.
        """
        camunda_ns = dict(ns)
        camunda_ns["camunda"] = "http://camunda.org/schema/1.0/bpmn"
        for prop in process.findall(
            "./bpmn:extensionElements/camunda:properties/camunda:property", camunda_ns
        ):
            if prop.get("name") == "project":
                return prop.get("value", "").strip().lower() in ("true", "1", "yes")
        return False
