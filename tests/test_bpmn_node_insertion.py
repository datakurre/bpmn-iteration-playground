from __future__ import annotations

import tempfile

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
    flows = {
        f.get("sourceRef"): f.get("targetRef")
        for f in tree.findall(".//bpmn:sequenceFlow", NS)
    }
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
    flows = {
        f.get("sourceRef"): f.get("targetRef")
        for f in tree.findall(".//bpmn:sequenceFlow", NS)
    }
    assert flows.get("Task_B") == "Task_C"


def test_result_is_valid_spiffworkflow() -> None:
    """The result can actually be loaded by WorkflowRunner."""
    base = linear_bpmn("Process_1", [("Task_A", "userTask")])
    spec = InsertionSpec(
        after="Task_A",
        nodes=[BpmnNode("Task_New", "New", "serviceTask")],
    )
    result = insert_nodes(base, spec)

    with tempfile.NamedTemporaryFile(suffix=".bpmn", mode="w", delete=False) as f:
        f.write(result)
        f.flush()
        runner = WorkflowRunner()
        workflow, _ = runner.load_workflow(f.name)
        assert "Task_New" in workflow.spec.task_specs
