from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from lxml import etree

from graph_agent.bpmn_utils import (
    BPMN_NS,
    CAMUNDA_NS,
    BpmnNode,
    InsertionSpec,
    insert_nodes,
    validate_bpmn,
)
from graph_agent.engine import WorkflowRunner
from tests.bpmn_helpers import linear_bpmn

NS = {
    "bpmn": BPMN_NS,
    "camunda": CAMUNDA_NS,
    "bpmndi": "http://www.omg.org/spec/BPMN/20100524/DI",
}


def test_insert_single_task() -> None:
    """Insert one service task between two existing nodes."""
    base = linear_bpmn("Process_1", [("Task_A", "userTask"), ("Task_B", "serviceTask")])
    spec = InsertionSpec(
        after="Task_A",
        nodes=[
            BpmnNode(
                bpmn_id="Task_New",
                name="New Task",
                element_type="serviceTask",
                properties={"harness_type": "pi_agent"},
            )
        ],
    )
    result = insert_nodes(base, spec)

    # Validate: the result has Task_A -> Task_New -> Task_B
    validation = validate_bpmn(result)
    assert validation.valid
    assert "Task_New" in validation.task_ids

    # Check flow order via XML
    tree = etree.fromstring(result.encode("utf-8"))
    flows = {f.get("sourceRef"): f.get("targetRef") for f in tree.findall(".//bpmn:sequenceFlow", NS)}
    assert flows.get("Task_A") == "Task_New"
    assert flows.get("Task_New") == "Task_B"


def test_insert_multiple_tasks() -> None:
    """Insert a sequence of three tasks."""
    base = linear_bpmn("Process_1", [("Start_Task", "userTask")])
    spec = InsertionSpec(
        after="Start_Task",
        nodes=[
            BpmnNode("Step_1", "Step 1", "serviceTask"),
            BpmnNode("Step_2", "Step 2", "userTask"),
            BpmnNode("Step_3", "Step 3", "serviceTask"),
        ],
    )
    result = insert_nodes(base, spec)
    validation = validate_bpmn(result)
    assert validation.valid
    assert all(f"Step_{i}" in validation.task_ids for i in [1, 2, 3])


def test_insert_with_camunda_extensions() -> None:
    """Inserted task has Camunda properties and input/output parameters."""
    base = linear_bpmn("Process_1", [("Task_A", "userTask")])
    spec = InsertionSpec(
        after="Task_A",
        nodes=[
            BpmnNode(
                "Task_Agent",
                "Agent",
                "serviceTask",
                properties={"harness_type": "pi_agent", "agent_role": "analyzer"},
                input_params={"goal": "${user_goal}"},
                output_params={"status": "${status}", "summary": "${summary}"},
            )
        ],
    )
    result = insert_nodes(base, spec)
    assert "harness_type" in result
    assert "agent_role" in result
    assert "${user_goal}" in result


def test_insert_after_nonexistent_node_fails() -> None:
    """Inserting after a node that doesn't exist raises ValueError."""
    base = linear_bpmn("Process_1", [("Task_A", "userTask")])
    spec = InsertionSpec(after="Nonexistent", nodes=[BpmnNode("X", "X", "serviceTask")])
    with pytest.raises(ValueError, match="not found"):
        insert_nodes(base, spec)


def test_insert_after_start_event() -> None:
    """Can insert right after the start event."""
    base = linear_bpmn("Process_1", [("Task_A", "userTask")])
    spec = InsertionSpec(
        after="StartEvent_1",
        nodes=[BpmnNode("Task_First", "First", "serviceTask")],
    )
    result = insert_nodes(base, spec)
    validation = validate_bpmn(result)
    assert validation.valid
    assert "Task_First" in validation.task_ids


def test_insert_preserves_existing_structure() -> None:
    """Nodes not involved in the insertion are unchanged."""
    base = linear_bpmn(
        "Process_1",
        [
            ("Task_A", "userTask"),
            ("Task_B", "serviceTask"),
            ("Task_C", "userTask"),
        ],
    )
    spec = InsertionSpec(
        after="Task_A",
        nodes=[BpmnNode("Task_New", "New", "serviceTask")],
    )
    result = insert_nodes(base, spec)

    # Task_B -> Task_C flow should be unchanged
    tree = etree.fromstring(result.encode("utf-8"))
    flows = {f.get("sourceRef"): f.get("targetRef") for f in tree.findall(".//bpmn:sequenceFlow", NS)}
    assert flows.get("Task_B") == "Task_C"


def test_result_is_valid_spiffworkflow() -> None:
    """The result can actually be loaded by WorkflowRunner."""
    base = linear_bpmn("Process_1", [("Task_A", "userTask")])
    spec = InsertionSpec(
        after="Task_A",
        nodes=[BpmnNode("Task_New", "New", "serviceTask")],
    )
    result = insert_nodes(base, spec)

    with tempfile.TemporaryDirectory() as temp_dir:
        bpmn_path = Path(temp_dir) / "test.bpmn"
        bpmn_path.write_text(result)
        runner = WorkflowRunner()
        workflow, _ = runner.load_workflow(str(bpmn_path))
        assert "Task_New" in workflow.spec.task_specs


def test_insert_nodes_rejects_xxe() -> None:
    """insert_nodes rejects XML with XXE entities."""
    xxe_xml = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe "file:///etc/passwd">]><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>'
    spec = InsertionSpec(after="x", nodes=[BpmnNode("T", "T", "serviceTask")])
    with pytest.raises(ValueError):
        insert_nodes(xxe_xml, spec)


def test_insert_handles_whitespace_in_flow_refs() -> None:
    """Insertion works when <incoming>/<outgoing> have whitespace around flow IDs."""
    base = """<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  id="Definitions_1">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1">
      <bpmn:outgoing>
        Flow_1
      </bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:userTask id="Task_A" name="Task A">
      <bpmn:incoming>
        Flow_1
      </bpmn:incoming>
      <bpmn:outgoing>
        Flow_2
      </bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:endEvent id="EndEvent_1">
      <bpmn:incoming>
        Flow_2
      </bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_A" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_A" targetRef="EndEvent_1" />
  </bpmn:process>
</bpmn:definitions>
"""
    spec = InsertionSpec(
        after="Task_A",
        nodes=[BpmnNode("Task_New", "New", "serviceTask")],
    )
    result = insert_nodes(base, spec)
    validation = validate_bpmn(result)
    assert validation.valid
    assert "Task_New" in validation.task_ids
    tree = etree.fromstring(result.encode("utf-8"))
    task_a = tree.find(".//*[@id='Task_A']")
    assert task_a is not None
    outgoings = [(elem.text or "").strip() for elem in task_a.findall(f"{{{BPMN_NS}}}outgoing")]
    assert "Flow_2" not in outgoings
