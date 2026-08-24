import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("bpmn.element_templates")


class ElementTemplatesRegistry:
    """Discovers bpmn-js element templates (JSON) for the modeler's template chooser.

    Each file under `templates_dir` is either a single template object or an array of
    them (both are valid element-templates JSON, same as bpmn-js itself accepts), and
    every file's templates are merged into one list for `elementTemplatesLoader.setTemplates()`.
    """

    def __init__(self, templates_dir: str = "element_templates") -> None:
        self.dir = Path(templates_dir)

    def list_templates(self) -> list[dict[str, Any]]:
        templates: list[dict[str, Any]] = []
        if not self.dir.exists():
            return templates

        for json_file in sorted(self.dir.glob("*.json")):
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to parse element template %s: %s", json_file, exc, exc_info=True)
                continue

            if isinstance(data, list):
                templates.extend(data)
            elif isinstance(data, dict):
                templates.append(data)
            else:
                logger.warning("Element template %s is neither an object nor an array; skipping", json_file)

        return templates
