import json
from typing import Any

from app.engine import WorkflowRunner


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
