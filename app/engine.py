from __future__ import annotations

import json
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser
from SpiffWorkflow.bpmn.workflow import BpmnWorkflow
from SpiffWorkflow.task import TaskState


class WorkflowRunner:
    def load_workflow(self, bpmn_path: str, process_id: str | None = None) -> tuple[BpmnWorkflow, str]:
        # First, find the primary process ID if not provided
        if not process_id:
            temp_parser = BpmnParser()
            temp_parser.add_bpmn_file(bpmn_path)
            process_id = temp_parser.get_process_ids()[0]

        parser = BpmnParser()
        bpmn_dir = Path(bpmn_path).parent
        for f in bpmn_dir.glob("*.bpmn"):
            parser.add_bpmn_file(str(f))
        
        workflow = BpmnWorkflow(parser.get_spec(process_id))
        
        # Load extensions for all loaded specs
        for f in bpmn_dir.glob("*.bpmn"):
            self._load_extensions(str(f), workflow)
            
        return workflow, process_id

    def _load_extensions(self, bpmn_path: str, workflow: BpmnWorkflow) -> None:
        root = ET.parse(bpmn_path).getroot()
        ns = {"bpmn": "http://www.omg.org/spec/BPMN/20100524/MODEL", "camunda": "http://camunda.org/schema/1.0/bpmn"}
        for element in root.findall(".//bpmn:*", ns):
            bpmn_id = element.get("id")
            if not bpmn_id or bpmn_id not in workflow.spec.task_specs:
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
                workflow.spec.task_specs[bpmn_id].extensions = {
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
        tasks = []
        for task in workflow.get_tasks(state=state):
            tasks.append(task)
        for task in workflow.get_tasks(state=TaskState.ANY_MASK):
            if type(task.task_spec).__name__ == "CallActivity" and hasattr(task, "workflow") and task.workflow:
                tasks.extend(self.get_all_tasks(task.workflow, state))
        return tasks

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
            if type(task.task_spec).__name__ == "CallActivity" and hasattr(task, "workflow") and task.workflow:
                try:
                    return self.find_task(task.workflow, task_id)
                except KeyError:
                    pass
        raise KeyError(task_id)

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
