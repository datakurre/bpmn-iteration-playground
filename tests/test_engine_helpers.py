import json
from typing import Any

from app.engine import WorkflowRunner, resolve_input


class FakeTaskSpec:
    def __init__(self, extensions: dict[str, Any] | None = None, bpmn_name: str | None = None, name: str = "TaskName") -> None:
        self.extensions = extensions
        self.bpmn_name = bpmn_name
        self.name = name


class FakeTask:
    def __init__(self, task_spec: FakeTaskSpec, task_id: str = "task-1", workflow: Any = None) -> None:
        self.task_spec = task_spec
        self.id = task_id
        if workflow is not None:
            self.workflow = workflow


class FakeWorkflow:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data


def test_pi_config_returns_empty_when_properties_not_a_dict() -> None:
    runner = WorkflowRunner()
    task = FakeTask(FakeTaskSpec(extensions={"properties": "not-a-dict"}))
    assert runner.pi_config(task) == {}


def test_pi_config_returns_empty_when_no_extensions() -> None:
    runner = WorkflowRunner()
    task = FakeTask(FakeTaskSpec(extensions=None))
    assert runner.pi_config(task) == {}


def test_pi_config_stringifies_property_values() -> None:
    runner = WorkflowRunner()
    task = FakeTask(FakeTaskSpec(extensions={"properties": {"agent_role": "reviewer", "count": 3}}))
    assert runner.pi_config(task) == {"agent_role": "reviewer", "count": "3"}


def test_prompt_falls_back_to_full_workflow_data_without_input_parameters() -> None:
    runner = WorkflowRunner()
    workflow = FakeWorkflow(data={"contract": "text", "extra": 1})
    task = FakeTask(FakeTaskSpec(extensions={}), workflow=workflow)

    prompt = runner.prompt("wf-1", task, workflow)
    context = json.loads(prompt.split("\n\n", 1)[1])
    assert context["variables"] == {"contract": "text", "extra": 1}


def test_prompt_resolves_input_parameter_variable_references() -> None:
    runner = WorkflowRunner()
    workflow = FakeWorkflow(data={"contract": "the contract text"})
    task = FakeTask(
        FakeTaskSpec(extensions={"inputParameters": {"document": "${contract}", "literal": "fixed value"}}),
        workflow=workflow,
    )

    prompt = runner.prompt("wf-1", task, workflow)
    context = json.loads(prompt.split("\n\n", 1)[1])
    assert context["variables"] == {"document": "the contract text", "literal": "fixed value"}


def test_input_parameter_resolves_nested_path() -> None:
    data = {"plan": {"status": "success", "steps": [{"name": "first"}]}}
    assert resolve_input("${plan.status}", data) == "success"
    assert resolve_input("${plan.steps.0.name}", data) == "first"


def test_input_parameter_nested_miss_is_none() -> None:
    assert resolve_input("${plan.nope}", {"plan": {}}) is None
    assert resolve_input("${nope.deeper}", {}) is None


def test_input_parameter_out_of_range_index_is_none() -> None:
    assert resolve_input("${items.5}", {"items": [1, 2]}) is None
    assert resolve_input("${items.notanindex}", {"items": [1, 2]}) is None


def test_input_parameter_interpolates_into_text() -> None:
    data = {"contract": "ACME MSA", "reviewer": "Ada"}
    assert resolve_input("Review ${contract} for ${reviewer}", data) == "Review ACME MSA for Ada"


def test_bare_expression_preserves_type() -> None:
    data = {"count": 3, "plan": {"steps": []}}
    assert resolve_input("${count}", data) == 3
    assert resolve_input("${plan}", data) == {"steps": []}


def test_interpolated_miss_becomes_empty_string() -> None:
    assert resolve_input("Review ${nope} now", {}) == "Review  now"


def test_literal_without_expression_is_unchanged() -> None:
    assert resolve_input("just a string", {"a": 1}) == "just a string"


def test_prompt_uses_nested_input_parameters() -> None:
    runner = WorkflowRunner()
    wf, _ = runner.load_workflow("tests/fixtures/nested_input_parameter.bpmn")
    wf.data["plan"] = {"status": "ready"}
    task = next(t for t in wf.get_tasks() if getattr(t.task_spec, "bpmn_id", None) == "Task_Use_Plan")

    prompt = runner.prompt("wf-1", task, wf)
    context = json.loads(prompt.split("\n\n", 1)[1])
    assert context["variables"] == {"plan_status": "ready"}


def _minimal_bpmn(process_id: str, agent_role: str, output_name: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Definitions_{process_id}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="{process_id}" name="{process_id}" isExecutable="true">
    <bpmn:documentation>{process_id}</bpmn:documentation>
    <bpmn:startEvent id="Start_{process_id}">
      <bpmn:outgoing>Flow_{process_id}_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="Flow_{process_id}_1" sourceRef="Start_{process_id}" targetRef="Task_Shared" />
    <bpmn:serviceTask id="Task_Shared" name="Shared Id">
      <bpmn:extensionElements>
        <camunda:properties>
          <camunda:property name="harness_type" value="pi_agent" />
          <camunda:property name="agent_role" value="{agent_role}" />
        </camunda:properties>
        <camunda:inputOutput>
          <camunda:outputParameter name="{output_name}">${{status}}</camunda:outputParameter>
        </camunda:inputOutput>
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_{process_id}_1</bpmn:incoming>
      <bpmn:outgoing>Flow_{process_id}_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="Flow_{process_id}_2" sourceRef="Task_Shared" targetRef="End_{process_id}" />
    <bpmn:endEvent id="End_{process_id}">
      <bpmn:incoming>Flow_{process_id}_2</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>
"""


def test_extensions_do_not_leak_between_templates_sharing_a_task_id() -> None:
    """A file's extensions apply only to the processes that file defines.

    Every `*.bpmn` in the directory is parsed so CallActivity targets resolve, and each is
    then walked for extensions. Matching by element id alone let a task id shared by two
    unrelated templates cross-apply properties and inputOutput in filesystem glob order.
    """
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmpdir:
        a = Path(tmpdir) / "alpha.bpmn"
        z = Path(tmpdir) / "zeta.bpmn"
        a.write_text(_minimal_bpmn("alpha", "alpha_role", "alpha_status"))
        z.write_text(_minimal_bpmn("zeta", "zeta_role", "zeta_status"))

        runner = WorkflowRunner()
        for path, process_id, role, output in (
            (a, "alpha", "alpha_role", "alpha_status"),
            (z, "zeta", "zeta_role", "zeta_status"),
        ):
            workflow, loaded_id = runner.load_workflow(str(path))
            assert loaded_id == process_id
            extensions = workflow.spec.task_specs["Task_Shared"].extensions
            assert extensions["properties"]["agent_role"] == role
            assert output in extensions["outputParameters"]
