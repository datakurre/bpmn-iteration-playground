from __future__ import annotations

import pytest
from lxml import etree
from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser
from SpiffWorkflow.bpmn.workflow import BpmnWorkflow
from SpiffWorkflow.task import TaskState

from graph_agent.bpmn_utils import replace_spec
from graph_agent.engine import WorkflowRunner
from tests.bpmn_helpers import linear_bpmn


def _init_workflow(xml: str, process_id: str = "Process_1") -> BpmnWorkflow:
    """Helper to initialize a BpmnWorkflow from XML with extensions loaded."""
    parser = BpmnParser()
    parser.add_bpmn_xml(etree.fromstring(xml.encode("utf-8")))
    wf = BpmnWorkflow(parser.get_spec(process_id))
    wf._bpmn_xml = xml  # type: ignore[attr-defined]
    wf.do_engine_steps()
    return wf


def test_replace_spec_same_graph() -> None:
    """Replacing with identical BPMN is a no-op — workflow continues."""
    xml = linear_bpmn("Process_1", [("Task_1", "userTask", {})])
    wf = _init_workflow(xml)

    wf_after, warnings = replace_spec(wf, xml)
    assert wf_after is wf
    assert warnings == []

    # Can complete task after replacement
    user_task = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_1")
    assert user_task.state == TaskState.READY
    user_task.complete()
    wf.do_engine_steps()
    assert wf.is_completed()


def test_replace_spec_adds_task_after_current() -> None:
    """Adding a new task after the current waiting position succeeds."""
    # BPMN v1: Start -> UserTask_1 -> End
    v1 = linear_bpmn("Process_1", [("UserTask_1", "userTask", {})])
    wf = _init_workflow(v1)

    # BPMN v2: Start -> UserTask_1 -> ServiceTask_New -> End
    v2 = linear_bpmn(
        "Process_1",
        [
            ("UserTask_1", "userTask", {}),
            ("ServiceTask_New", "serviceTask", {"harness_type": "pi_agent", "agent_role": "executor"}),
        ],
    )

    replace_spec(wf, v2)

    # Complete UserTask_1
    user_task = next(t for t in wf.get_tasks() if t.task_spec.name == "UserTask_1")
    assert user_task.state == TaskState.READY
    user_task.complete()
    wf.do_engine_steps()

    # ServiceTask_New should now exist in READY/STARTED state
    new_task = [t for t in wf.get_tasks() if t.task_spec.name == "ServiceTask_New"]
    assert len(new_task) == 1
    assert new_task[0].state in (TaskState.READY, TaskState.STARTED)


def test_replace_spec_removes_completed_task_warns() -> None:
    """Removing a task that's already completed produces a warning, not an error."""
    # BPMN v1: Start -> Task_A -> Task_B -> End
    v1 = linear_bpmn("Process_1", [("Task_A", "userTask", {}), ("Task_B", "userTask", {})])
    wf = _init_workflow(v1)

    # Complete Task_A so workflow is waiting at Task_B
    task_a = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_A")
    task_a.complete()
    wf.do_engine_steps()

    task_b = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_B")
    assert task_b.state == TaskState.READY

    # BPMN v2: Start -> Task_B -> End (Task_A removed)
    v2 = linear_bpmn("Process_1", [("Task_B", "userTask", {})])

    _, warnings = replace_spec(wf, v2)
    assert any("Task_A" in w for w in warnings)

    # Task_B should still be ready and able to complete
    task_b.complete()
    wf.do_engine_steps()
    assert wf.is_completed()


def test_replace_spec_removes_active_task_fails() -> None:
    """Removing the task the workflow is currently waiting at raises ValueError."""
    # BPMN v1: Start -> Task_A -> Task_B -> End
    v1 = linear_bpmn("Process_1", [("Task_A", "userTask", {}), ("Task_B", "userTask", {})])
    wf = _init_workflow(v1)

    # Waiting at Task_A
    # BPMN v2: Start -> Task_B -> End (Task_A removed)
    v2 = linear_bpmn("Process_1", [("Task_B", "userTask", {})])

    with pytest.raises(ValueError, match="Task_A"):
        replace_spec(wf, v2)


def test_replace_spec_updates_extensions() -> None:
    """Camunda extensions on existing tasks are updated to new values."""
    v1 = linear_bpmn(
        "Process_1",
        [("Task_Agent", "serviceTask", {"harness_type": "pi_agent", "agent_role": "planner"})],
    )
    wf = _init_workflow(v1)

    v2 = linear_bpmn(
        "Process_1",
        [("Task_Agent", "serviceTask", {"harness_type": "pi_agent", "agent_role": "executor"})],
    )

    replace_spec(wf, v2)

    agent_task = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_Agent")
    props = getattr(agent_task.task_spec, "extensions", {}).get("properties", {})
    assert props.get("agent_role") == "executor"


def test_replace_spec_preserves_data() -> None:
    """Workflow data (workflow.data) is preserved across spec replacement."""
    v1 = linear_bpmn("Process_1", [("Task_1", "userTask", {})])
    wf = _init_workflow(v1)
    wf.data["preserved_key"] = {"score": 42, "items": ["a", "b"]}

    v2 = linear_bpmn("Process_1", [("Task_1", "userTask", {}), ("Task_2", "userTask", {})])
    replace_spec(wf, v2)

    assert wf.data.get("preserved_key") == {"score": 42, "items": ["a", "b"]}


def test_replace_spec_preserves_task_state() -> None:
    """Completed tasks stay completed, waiting/ready tasks stay ready."""
    v1 = linear_bpmn(
        "Process_1",
        [("Task_1", "userTask", {}), ("Task_2", "userTask", {}), ("Task_3", "userTask", {})],
    )
    wf = _init_workflow(v1)

    # Complete Task_1 -> Task_2 becomes READY
    t1 = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_1")
    t1.complete()
    wf.do_engine_steps()

    t2 = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_2")
    assert t2.state == TaskState.READY

    v2 = linear_bpmn(
        "Process_1",
        [
            ("Task_1", "userTask", {}),
            ("Task_2", "userTask", {}),
            ("Task_3", "userTask", {}),
            ("Task_4", "userTask", {}),
        ],
    )
    replace_spec(wf, v2)

    t1_after = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_1")
    t2_after = next(t for t in wf.get_tasks() if t.task_spec.name == "Task_2")
    assert t1_after.state == TaskState.COMPLETED
    assert t2_after.state == TaskState.READY


def test_replace_spec_updates_bpmn_xml() -> None:
    """After replacement, extract_bpmn_xml returns the new XML."""
    runner = WorkflowRunner()
    v1 = linear_bpmn("Process_1", [("Task_1", "userTask", {})])
    wf = _init_workflow(v1)

    v2 = linear_bpmn("Process_1", [("Task_1", "userTask", {}), ("Task_2", "userTask", {})])
    replace_spec(wf, v2)

    extracted = runner.extract_bpmn_xml(wf)
    assert "Task_2" in extracted


def test_replace_spec_invalid_xml_fails() -> None:
    """Invalid XML raises ValueError when passed to replace_spec."""
    v1 = linear_bpmn("Process_1", [("Task_1", "userTask", {})])
    wf = _init_workflow(v1)

    with pytest.raises(ValueError, match="Invalid BPMN XML"):
        replace_spec(wf, "<not valid xml")


def test_replace_spec_cleans_predicted_chain() -> None:
    """Predicted grandchild tasks don't survive spec replacement as orphans."""
    three_task_xml = linear_bpmn(
        "Process_1",
        [
            ("Task_A", "userTask", {}),
            ("Task_B", "userTask", {}),
            ("Task_C", "userTask", {}),
        ],
    )
    wf = _init_workflow(three_task_xml)

    # Count future tasks before replacement
    future_before = [t for t in wf.tasks.values() if t.state in (TaskState.FUTURE, TaskState.MAYBE, TaskState.LIKELY)]
    assert len(future_before) > 0

    # Replace with same spec
    wf, _warnings = replace_spec(wf, three_task_xml)

    # No orphaned future tasks pointing at old spec objects
    for task in wf.tasks.values():
        if task.state in (TaskState.FUTURE, TaskState.MAYBE, TaskState.LIKELY):
            assert task.task_spec in wf.spec.task_specs.values() or any(
                task.task_spec in s.task_specs.values() for s in wf.subprocess_specs.values()
            ), f"Orphaned future task {task.task_spec.name} references old spec"
