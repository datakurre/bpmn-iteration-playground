from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser
from SpiffWorkflow.bpmn.workflow import BpmnWorkflow
from SpiffWorkflow.task import TaskState

from app.xml_utils import safe_parse_xml


class WorkflowRunner:
    def load_workflow(self, bpmn_path: str, process_id: str | None = None) -> tuple[BpmnWorkflow, str]:
        if not process_id:
            root = safe_parse_xml(bpmn_path).getroot()
            if root is not None:
                for elem in root.iter():
                    if elem.tag.endswith("process") and elem.get("id"):
                        process_id = elem.get("id")
                        break

        bpmn_dir = Path(bpmn_path).parent
        parser = BpmnParser()
        
        # Load all BPMN files in the same directory (enables call activities/subprocesses)
        for f in bpmn_dir.glob("*.bpmn"):
            parser.add_bpmn_file(str(f))
        
        if not process_id:
            process_ids = parser.get_process_ids()
            if not process_ids:
                raise ValueError(f"No processes found in BPMN files in {bpmn_dir}")
            process_id = process_ids[0]

        workflow = BpmnWorkflow(
            parser.get_spec(process_id),
            parser.get_subprocess_specs(process_id),
        )

        # Load extensions for the top-level spec and every called subprocess spec
        for f in bpmn_dir.glob("*.bpmn"):
            self._load_extensions(str(f), workflow)

        return workflow, process_id

    def _load_extensions(self, bpmn_path: str, workflow: BpmnWorkflow) -> None:
        root = safe_parse_xml(bpmn_path).getroot()
        if root is None:
            return
        ns = {"bpmn": "http://www.omg.org/spec/BPMN/20100524/MODEL", "camunda": "http://camunda.org/schema/1.0/bpmn"}
        specs = [workflow.spec, *getattr(workflow, "subprocess_specs", {}).values()]
        for element in root.findall(".//bpmn:*", ns):
            bpmn_id = element.get("id")
            if not bpmn_id:
                continue
            target_specs = [spec for spec in specs if bpmn_id in spec.task_specs]
            if not target_specs:
                continue

            properties = {
                prop.get("name"): prop.get("value", "")
                for prop in element.findall("./bpmn:extensionElements/camunda:properties/camunda:property", ns)
                if prop.get("name")
            }

            fields = []
            for field in element.findall("./bpmn:extensionElements/camunda:formData/camunda:formField", ns):
                field_data: dict[str, Any] = {
                    "id": field.get("id"),
                    "label": field.get("label"),
                    "type": field.get("type", "string"),
                }
                values = [
                    {"id": v.get("id"), "name": v.get("name", v.get("id"))}
                    for v in field.findall("camunda:value", ns)
                ]
                if values:
                    field_data["values"] = values
                fields.append(field_data)

            inputs = {}
            for param in element.findall("./bpmn:extensionElements/camunda:inputOutput/camunda:inputParameter", ns):
                name = param.get("name")
                value = param.text or ""
                if name:
                    inputs[name] = value.strip()

            outputs = {}
            for param in element.findall("./bpmn:extensionElements/camunda:inputOutput/camunda:outputParameter", ns):
                name = param.get("name")
                value = param.text or ""
                if name:
                    outputs[name] = value.strip()

            if properties or fields or inputs or outputs:
                for spec in target_specs:
                    spec.task_specs[bpmn_id].extensions = {
                        "properties": properties,
                        "form": {"fields": fields},
                        "inputParameters": inputs,
                        "outputParameters": outputs,
                    }

    def start(self, bpmn_path: str, process_id: str | None, variables: dict[str, Any]) -> tuple[str, BpmnWorkflow, str]:
        workflow, process_id = self.load_workflow(bpmn_path, process_id)
        workflow.data.update(variables)
        workflow.do_engine_steps()
        return uuid.uuid4().hex, workflow, process_id

    def get_all_tasks(self, workflow: BpmnWorkflow, state: TaskState | int) -> list[Any]:
        """All tasks in the instance, including those inside called subprocesses.

        `BpmnTaskIterator` already descends into active subprocesses, so no manual
        recursion is needed (and `task.workflow` is the containing workflow, not the
        subprocess -- recursing on it never terminates).
        """
        return list(workflow.get_tasks(state=state))

    def task_snapshot(self, workflow: BpmnWorkflow) -> list[dict[str, Any]]:
        return [
            {
                "id": str(task.id),
                "bpmn_id": getattr(task.task_spec, "bpmn_id", task.task_spec.name),
                "name": getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                "state": TaskState.get_name(task.state),
                "type": task.task_spec.__class__.__name__,
            }
            for task in self.get_all_tasks(workflow, TaskState.ANY_MASK)
            if getattr(task.task_spec, "bpmn_id", None)
            if task.state & (TaskState.READY | TaskState.STARTED | TaskState.COMPLETED)
        ]

    def record(self, workflow_id: str, workflow: BpmnWorkflow, bpmn_path: str, process_id: str, status: str, **extra: Any) -> dict[str, Any]:
        return {
            "workflow": workflow,
            "bpmn_path": str(Path(bpmn_path)),
            "process_id": process_id,
            "status": status,
            "tasks": self.task_snapshot(workflow),
            "data": dict(workflow.data),
            **extra,
        }

    def find_task(self, workflow: BpmnWorkflow, task_id: str) -> Any:
        for task in workflow.get_tasks(state=TaskState.ANY_MASK):
            if str(task.id) == task_id:
                return task
        raise KeyError(task_id)

    @staticmethod
    def subprocess_of(workflow: BpmnWorkflow, task: Any) -> Any:
        """The subprocess a CallActivity task launched, or None."""
        top = getattr(task.workflow, "top_workflow", workflow)
        return top.subprocesses.get(task.id)

    def pi_config(self, task: Any) -> dict[str, str]:
        extensions = getattr(task.task_spec, "extensions", {}) or {}
        properties = extensions.get("properties", extensions.get("camunda:properties", {}))
        if isinstance(properties, dict):
            return {str(key): str(value) for key, value in properties.items()}
        return {}

    def prompt(self, workflow_id: str, task: Any, workflow: BpmnWorkflow) -> str:
        config = self.pi_config(task)
        extensions = getattr(task.task_spec, "extensions", {}) or {}
        input_params = extensions.get("inputParameters", {})

        target_wf = getattr(task, "workflow", workflow)

        if input_params:
            variables: dict[str, Any] = {}
            for name, expr in input_params.items():
                if expr.startswith("${") and expr.endswith("}"):
                    var_name = expr[2:-1]
                    variables[name] = target_wf.data.get(var_name)
                else:
                    variables[name] = expr
        else:
            variables = dict(target_wf.data)

        context = {
            "workflow_id": workflow_id,
            "task_id": task.id,
            "task_name": getattr(task.task_spec, "bpmn_name", task.task_spec.name),
            "agent_role": config.get("agent_role"),
            "variables": variables,
        }
        return (
            "Complete this BPMN task. Make the requested repository changes or analysis, "
            "then respond with only one valid JSON object containing status, summary, "
            "findings, artifacts, and next_action. Do not wrap it in markdown.\n\n"
            + json.dumps(context, default=str)
        )
