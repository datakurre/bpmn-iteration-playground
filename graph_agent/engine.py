from __future__ import annotations

import contextlib
import json
import logging
import re
import uuid
from pathlib import Path
from typing import Any

from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser
from SpiffWorkflow.bpmn.specs.mixins.subworkflow_task import CallActivity
from SpiffWorkflow.bpmn.workflow import BpmnWorkflow
from SpiffWorkflow.task import TaskState

from graph_agent.xml_utils import safe_parse_xml

logger = logging.getLogger("bpmn.engine")

_EXPR_RE = re.compile(r"\$\{([^}]*)\}")
_INDEX_RE = re.compile(r"-?\d+")


def _resolve_path(path: str, data: Any) -> Any:
    """Walk a dotted path through nested dicts/lists. Any miss (key, index, or wrong
    container type) yields None rather than raising -- a bad expression should fail the
    expression, not the whole prompt build.
    """
    current = data
    for segment in path.split("."):
        if isinstance(current, dict):
            if segment not in current:
                return None
            current = current[segment]
        elif isinstance(current, (list, tuple)):
            if not _INDEX_RE.fullmatch(segment):
                return None
            index = int(segment)
            if not -len(current) <= index < len(current):
                return None
            current = current[index]
        else:
            return None
    return current


def resolve_input(expr: str, data: dict[str, Any]) -> Any:
    """Resolve a camunda:inputParameter expression against workflow/task data.

    Deliberately not a general expression language (see plans/bpmn.md): pure dict/list
    lookup plus string substitution, nothing more. In particular this must never route
    through SpiffWorkflow's script engine or `eval` -- these values are interpolated into
    agent prompts, and workflow data an agent previously wrote must not be evaluated as code.

    - A literal string with no `${...}` passes through unchanged.
    - A whole-string expression (`${a.b.c}`, list indices supported) returns the resolved
      *value* with its native type -- gateways and agent JSON depend on ints/lists/dicts
      surviving, not becoming strings.
    - A mixed string (`"Review ${contract}"`) interpolates every `${...}` occurrence,
      stringifying each resolved value; a miss becomes an empty string rather than leaking
      a literal `${...}` into the prompt.
    """
    if "${" not in expr:
        return expr

    whole = _EXPR_RE.fullmatch(expr)
    if whole:
        return _resolve_path(whole.group(1), data)

    def _substitute(match: re.Match[str]) -> str:
        value = _resolve_path(match.group(1), data)
        return "" if value is None else str(value)

    return _EXPR_RE.sub(_substitute, expr)


def resolve_scope_inputs(input_params: dict[str, str], data: dict[str, Any]) -> dict[str, Any]:
    """Resolve every declared camunda:inputParameter into a child execution scope.

    Deliberately no fallback to the whole of `data`: an element with no declared
    inputParameters gets an empty scope, not implicit access to everything its container
    knows. This is the only way variables enter a child scope -- see
    docs/variable-scoping-plan.md.
    """
    return {name: resolve_input(expr, data) for name, expr in input_params.items()}


def resolve_output_mapping(output_params: dict[str, str], sources: dict[str, Any]) -> dict[str, Any]:
    """Resolve every declared camunda:outputParameter against a completed scope's local data.

    This is the only way a child scope's data reaches its parent. `source_expr` is usually
    a bare key (`status`) but also accepts the `${status}` form some templates use.
    """
    published: dict[str, Any] = {}
    for target_var, source_expr in output_params.items():
        source_key = (
            source_expr[2:-1]
            if source_expr.startswith("${") and source_expr.endswith("}")
            else source_expr
        )
        published[target_var] = sources.get(source_key)
    return published


def _scope_extensions(task_spec: Any) -> dict[str, Any]:
    return getattr(task_spec, "extensions", {}) or {}


def _scoped_copy_data(self: Any, my_task: Any, subworkflow: Any) -> None:
    """Seed a called process's start task from the caller's own mapped inputs only.

    Replaces `CallActivity.copy_data`, which (absent a BPMN `ioSpecification`, which this
    app's templates don't use) copies the *entire* calling task's data into the called
    process. Here the called process's scope contains exactly its `camunda:inputParameter`s,
    resolved against the caller's own scope (`my_task.workflow.data` -- the enclosing
    process/subprocess variables, the same source `resolve_scope_inputs` uses for a
    ServiceTask).
    """
    input_params = _scope_extensions(self).get("inputParameters", {})
    mapped = resolve_scope_inputs(input_params, my_task.workflow.data)
    start = subworkflow.get_next_task(spec_name="Start")
    start.set_data(**mapped)


def _scoped_update_data(self: Any, my_task: Any, subworkflow: Any) -> None:
    """Publish only a called process's mapped outputs back to the caller's scope.

    Replaces `CallActivity.update_data`, which copies the called process's *entire*
    terminal task data back onto the calling task. Resolves against `subworkflow.data` --
    the called process's own instance-wide scope, which accumulates every completed task's
    declared outputs -- rather than the terminal task's `task.data` chain, since a UserTask
    inside the called process narrows its own local `task.data` to its inputs/outputs and is
    not a reliable carrier for something an earlier sibling task published.
    """
    output_params = _scope_extensions(self).get("outputParameters", {})
    my_task.data = resolve_output_mapping(output_params, subworkflow.data)


def _patch_call_activity_scoping() -> None:
    """Install explicit camunda:inputOutput scoping on CallActivity, in place of SpiffWorkflow's
    default full-data copy in and out.

    Applied once at import time, and deliberately narrow: only `CallActivity` is patched here,
    not the shared `SubWorkflowTask` base it and embedded/transaction/event SubProcess all
    inherit `copy_data`/`update_data` from. SpiffWorkflow 3.2.0 parses every
    `triggeredByEvent="true"` subprocess as plain `SubWorkflowTask` (see `_sync_children`'s
    isinstance note in workflow_service.py) -- there is no class-level way to single out "an
    embedded SubProcess" from "an event SubProcess" the way `CallActivity` can be singled out
    from both, so extending explicit mapping to those is deferred rather than guessed at; see
    docs/variable-scoping-plan.md.
    """
    CallActivity.copy_data = _scoped_copy_data
    CallActivity.update_data = _scoped_update_data


_patch_call_activity_scoping()


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
        workflow._bpmn_xml = Path(bpmn_path).read_text(encoding="utf-8")
        workflow._bpmn_path = str(bpmn_path)

        # Load extensions for the top-level spec and every called subprocess spec
        for f in bpmn_dir.glob("*.bpmn"):
            self._load_extensions(str(f), workflow)

        return workflow, process_id

    def extract_bpmn_xml(self, workflow: BpmnWorkflow) -> str:
        """Return the BPMN XML of the workflow's current spec."""
        xml = getattr(workflow, "_bpmn_xml", None)
        if xml is not None:
            return str(xml)
        bpmn_path = getattr(workflow, "_bpmn_path", None)
        if bpmn_path and Path(bpmn_path).exists():
            return Path(bpmn_path).read_text(encoding="utf-8")
        raise ValueError("No BPMN XML available for this workflow instance")

    @staticmethod
    def _specs_defined_by(
        bpmn_path: str, root: Any, ns: dict[str, str], workflow: BpmnWorkflow
    ) -> list[Any]:
        """The loaded specs this file actually defines, keyed by process id.

        Every `*.bpmn` in the directory is parsed and then walked for extensions -- that is
        how a CallActivity target in a sibling file gets its `camunda:properties`. Matching
        elements by id alone would therefore let two templates that happen to share a task
        id cross-apply each other's properties, forms and inputOutput: silently, and in
        filesystem glob order, so it need not even fail the same way twice. Scoping each
        file to its own processes keeps sibling-file loading without that coupling.
        """
        specs_by_name: dict[str, Any] = {}
        top_name = getattr(workflow.spec, "name", None)
        if top_name:
            specs_by_name[str(top_name)] = workflow.spec
        for name, spec in (getattr(workflow, "subprocess_specs", None) or {}).items():
            specs_by_name[str(name)] = spec

        specs = []
        seen: set[int] = set()
        # Embedded/event/transaction/ad-hoc subprocesses get their own entry in
        # workflow.subprocess_specs (keyed by the subprocess element's own id, e.g. "Spawn"
        # for a triggeredByEvent="true" one) exactly like a CallActivity's called process --
        # but they're declared with a *different* XML tag than a top-level process, so they
        # need their own XPath here. Without this, extensions on any task nested inside an
        # embedded/event subprocess (camunda:properties, formData, inputOutput) are silently
        # never attached to that task's spec at all.
        for tag in ("bpmn:process", "bpmn:subProcess", "bpmn:transaction", "bpmn:adHocSubProcess"):
            for element in root.findall(f".//{tag}", ns):
                element_id = element.get("id")
                spec = specs_by_name.get(element_id) if element_id else None
                if spec is not None and id(spec) not in seen:
                    seen.add(id(spec))
                    specs.append(spec)
        if not specs:
            logger.debug("No loaded spec defined by %s; skipping its extensions", bpmn_path)
        return specs

    def _load_extensions(self, bpmn_path: str, workflow: BpmnWorkflow) -> None:
        root = safe_parse_xml(bpmn_path).getroot()
        if root is None:
            return
        ns = {"bpmn": "http://www.omg.org/spec/BPMN/20100524/MODEL", "camunda": "http://camunda.org/schema/1.0/bpmn"}
        specs = self._specs_defined_by(bpmn_path, root, ns, workflow)
        if not specs:
            return
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
        # No fallback to the whole of target_wf.data: an undeclared input means an empty
        # scope, not implicit access to everything the containing process knows -- see
        # docs/variable-scoping-plan.md.
        target_data = dict(target_wf.data)
        if "__current_spec" not in target_data:
            with contextlib.suppress(Exception):
                target_data["__current_spec"] = self.extract_bpmn_xml(target_wf)
        variables = resolve_scope_inputs(input_params, target_data)

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
