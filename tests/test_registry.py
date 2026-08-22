import tempfile
import time
from pathlib import Path

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


def test_registry_skips_and_caches_unparsable_files() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        bpmn_file = Path(tmpdir) / "broken.bpmn"
        bpmn_file.write_text("<not-well-formed-xml")

        registry = WorkflowRegistry(tmpdir)
        assert registry.list_templates() == []
        # unparsable file is not cached (exception raised before the cache write)
        assert str(bpmn_file) not in registry._cache

        # second call re-attempts parsing (still fails), still yields no templates
        assert registry.list_templates() == []


def test_registry_caches_and_skips_files_with_no_process_element() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        bpmn_file = Path(tmpdir) / "empty.bpmn"
        bpmn_file.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">
</bpmn:definitions>
""")
        registry = WorkflowRegistry(tmpdir)
        assert registry.list_templates() == []
        # cached as a None template (mtime recorded, no crash on unchanged re-list)
        assert str(bpmn_file) in registry._cache
        assert registry.list_templates() == []


def test_registry_falls_back_to_any_process_when_none_is_executable() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        bpmn_file = Path(tmpdir) / "draft.bpmn"
        bpmn_file.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Draft_Process" name="Draft Process" isExecutable="false" />
</bpmn:definitions>
""")
        registry = WorkflowRegistry(tmpdir)
        templates = registry.list_templates()
        assert len(templates) == 1
        assert templates[0].id == "Draft_Process"


def test_registry_get_template_matches_by_path_stem_and_returns_none_for_unknown() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        bpmn_file = Path(tmpdir) / "my_workflow.bpmn"
        bpmn_file.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_Different_Id" name="A Process" isExecutable="true" />
</bpmn:definitions>
""")
        registry = WorkflowRegistry(tmpdir)
        assert registry.get_template("my_workflow") is not None
        assert registry.get_template("no-such-template") is None


def test_registry_list_templates_on_missing_directory() -> None:
    registry = WorkflowRegistry("/no/such/directory")
    assert registry.list_templates() == []


def test_shipped_workflows_do_not_share_flow_node_ids() -> None:
    """Flow-node ids must be unique across every file in `workflows/`.

    `WorkflowRunner._load_extensions` loads every `*.bpmn` in the directory (that is how
    CallActivity targets resolve) and applies each element's extensions to *any* loaded spec
    declaring a task of that id, without checking which process it came from. Two templates
    sharing a task id therefore cross-apply each other's `camunda:properties`,
    `formData` and `inputOutput` -- silently, and in filesystem glob order, so it does not
    even fail the same way twice.
    """
    import collections

    from app.xml_utils import safe_parse_xml

    ns = "{http://www.omg.org/spec/BPMN/20100524/MODEL}"
    flow_node_tags = {
        f"{ns}{tag}"
        for tag in (
            "serviceTask",
            "userTask",
            "scriptTask",
            "manualTask",
            "task",
            "callActivity",
            "subProcess",
            "exclusiveGateway",
            "parallelGateway",
            "inclusiveGateway",
            "startEvent",
            "endEvent",
            "intermediateCatchEvent",
            "intermediateThrowEvent",
            "boundaryEvent",
        )
    }

    owners: dict[str, set[str]] = collections.defaultdict(set)
    for path in sorted(Path("workflows").glob("*.bpmn")):
        root = safe_parse_xml(str(path)).getroot()
        for element in root.iter():
            if element.tag in flow_node_tags and (node_id := element.get("id")):
                owners[node_id].add(path.name)

    collisions = {node_id: sorted(files) for node_id, files in owners.items() if len(files) > 1}
    assert not collisions, f"flow-node ids shared between templates: {collisions}"
