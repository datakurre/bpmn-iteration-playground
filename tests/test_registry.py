import time
from pathlib import Path
import tempfile
import pytest
from app.registry import WorkflowRegistry


def test_registry_caching_and_invalidation() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        bpmn_file = Path(tmpdir) / "test.bpmn"
        bpmn_file.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_V1" name="Process Version 1" isExecutable="true">
    <bpmn:documentation>Version 1 description</bpmn:documentation>
  </bpmn:process>
</bpmn:definitions>
""")

        registry = WorkflowRegistry(tmpdir)
        templates = registry.list_templates()
        assert len(templates) == 1
        assert templates[0].id == "Process_V1"
        assert templates[0].name == "Process Version 1"

        # Direct cache check
        assert hasattr(registry, "_cache")
        assert str(bpmn_file) in registry._cache

        # Modify file with slight sleep to ensure distinct mtime
        time.sleep(0.05)
        bpmn_file.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_V2" name="Process Version 2" isExecutable="true">
    <bpmn:documentation>Version 2 description</bpmn:documentation>
  </bpmn:process>
</bpmn:definitions>
""")

        # Should detect new mtime and reload
        template = registry.get_template("Process_V2")
        assert template is not None
        assert template.id == "Process_V2"
        assert template.name == "Process Version 2"
