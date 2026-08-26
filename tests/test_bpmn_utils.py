from __future__ import annotations

from pathlib import Path

from graph_agent.bpmn_utils import validate_bpmn, validate_extensions
from tests.bpmn_helpers import (
    bpmn_with_bare_service_task,
    bpmn_with_camunda_service_task,
    bpmn_with_orphan_task,
    minimal_bpmn,
)


def test_valid_bpmn_passes() -> None:
    """A well-formed BPMN with one process, start, service task, end validates."""
    xml = minimal_bpmn("Process_1", [("Task_1", "serviceTask")])
    result = validate_bpmn(xml)
    assert result.valid is True
    assert "Process_1" in result.process_ids
    assert "Task_1" in result.task_ids
    assert result.errors == []


def test_malformed_xml_fails() -> None:
    """Broken XML reports valid=False with a parse error."""
    result = validate_bpmn("<not xml")
    assert result.valid is False
    assert any("parse" in e.lower() or "xml" in e.lower() for e in result.errors)


def test_no_process_fails() -> None:
    """Valid XML but no <bpmn:process> element reports valid=False."""
    xml = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>'
    result = validate_bpmn(xml)
    assert result.valid is False
    assert any("process" in e.lower() for e in result.errors)


def test_disconnected_task_fails() -> None:
    """A task with no incoming or outgoing sequence flow fails SpiffWorkflow parsing."""
    xml = bpmn_with_orphan_task()
    result = validate_bpmn(xml)
    assert result.valid is False
    assert len(result.errors) > 0


def test_camunda_extensions_extracted() -> None:
    """Validates that task_ids includes tasks with Camunda extensions."""
    xml = bpmn_with_camunda_service_task()
    result = validate_bpmn(xml)
    assert result.valid is True
    assert "Task_Agent" in result.task_ids


def test_validate_extensions_warns_missing_harness() -> None:
    """A ServiceTask without harness_type property produces a warning."""
    xml = bpmn_with_bare_service_task()
    warnings = validate_extensions(xml)
    assert any("harness_type" in w for w in warnings)


def test_validate_extensions_warns_missing_agent_role() -> None:
    """A ServiceTask with pi_agent but missing agent_role produces a warning."""
    xml = bpmn_with_camunda_service_task(agent_role="")
    warnings = validate_extensions(xml)
    assert any("agent_role" in w for w in warnings)


def test_validate_extensions_errors_nested_input_parameter() -> None:
    """An inputParameter with nested ${} is flagged as an injection risk error."""
    xml = bpmn_with_camunda_service_task(input_params={"bad": "${outer.${inner}}"})
    result = validate_bpmn(xml)
    assert result.valid is False
    assert any("nested" in e.lower() or "injection" in e.lower() for e in result.errors)

    messages = validate_extensions(xml)
    assert any("nested" in m.lower() or "injection" in m.lower() for m in messages)


def test_validate_extensions_errors_unknown_harness_type() -> None:
    """A ServiceTask with an unknown harness_type is flagged as an error."""
    xml = bpmn_with_camunda_service_task(harness_type="unknown_engine")
    result = validate_bpmn(xml)
    assert result.valid is False
    assert any("unknown_engine" in e or "harness_type" in e for e in result.errors)

    messages = validate_extensions(xml)
    assert any("unknown_engine" in m or "harness_type" in m for m in messages)


def test_validate_extensions_warns_unknown_output_source() -> None:
    """An outputParameter referencing an unknown source key produces a warning."""
    xml = bpmn_with_camunda_service_task(output_params={"custom_var": "${nonexistent_output_key}"})
    warnings = validate_extensions(xml)
    assert any("nonexistent_output_key" in w or "unknown source" in w for w in warnings)


def test_xxe_xml_fails_validation() -> None:
    """XML containing entity definitions / XXE attacks fails validation safely."""
    xxe_xml = """<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE root [
        <!ENTITY xxe SYSTEM "file:///etc/hosts">
    ]>
    <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">
      <bpmn:process id="Process_1" isExecutable="true">
        <bpmn:startEvent id="StartEvent_1"/>
      </bpmn:process>
    </bpmn:definitions>"""
    result = validate_bpmn(xxe_xml)
    assert result.valid is False
    assert len(result.errors) > 0


def test_all_bundled_workflows_validate() -> None:
    """Every bundled BPMN template in graph_agent/data/workflows validates successfully."""
    workflow_dir = Path(__file__).resolve().parents[1] / "graph_agent" / "data" / "workflows"
    bpmn_files = list(workflow_dir.glob("*.bpmn"))
    assert len(bpmn_files) > 0, "No bundled workflows found"

    for bpmn_path in bpmn_files:
        xml_content = bpmn_path.read_text(encoding="utf-8")
        result = validate_bpmn(xml_content)
        assert result.valid is True, f"{bpmn_path.name} failed validation: {result.errors}"
        assert len(result.process_ids) > 0, f"{bpmn_path.name} has no process_ids"
        assert len(result.task_ids) > 0, f"{bpmn_path.name} has no task_ids"
