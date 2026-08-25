import json
import tempfile
from pathlib import Path

from graph_agent.element_templates_registry import ElementTemplatesRegistry


def test_registry_merges_array_and_object_files() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        (Path(tmpdir) / "array.json").write_text(json.dumps([{"id": "a"}, {"id": "b"}]))
        (Path(tmpdir) / "object.json").write_text(json.dumps({"id": "c"}))

        registry = ElementTemplatesRegistry(tmpdir)
        ids = {t["id"] for t in registry.list_templates()}
        assert ids == {"a", "b", "c"}


def test_registry_skips_unparsable_and_non_object_files() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        (Path(tmpdir) / "broken.json").write_text("{not valid json")
        (Path(tmpdir) / "scalar.json").write_text("42")
        (Path(tmpdir) / "ok.json").write_text(json.dumps({"id": "ok"}))

        registry = ElementTemplatesRegistry(tmpdir)
        templates = registry.list_templates()
        assert [t["id"] for t in templates] == ["ok"]


def test_registry_list_templates_on_missing_directory() -> None:
    registry = ElementTemplatesRegistry("/no/such/directory")
    assert registry.list_templates() == []


def test_shipped_element_templates_are_well_formed() -> None:
    registry = ElementTemplatesRegistry("element_templates")
    templates = registry.list_templates()
    assert len(templates) >= 2

    seen_ids: set[str] = set()
    for template in templates:
        assert isinstance(template.get("id"), str) and template["id"]
        assert template["id"] not in seen_ids, f"duplicate element template id: {template['id']}"
        seen_ids.add(template["id"])

        assert isinstance(template.get("name"), str) and template["name"]
        assert isinstance(template.get("appliesTo"), list) and template["appliesTo"]
        assert isinstance(template.get("properties"), list)
        for prop in template["properties"]:
            assert "binding" in prop
            assert "type" in prop["binding"]
