"""Child-workflow sync: mirrors every CallActivity / event-subprocess child of a root
workflow into its own ZODB record with a `parent_workflow_id` back-reference.

Split out of `WorkflowService` because it is a self-contained recursive walk invoked
from every mutation method (`start`, `submit_task`, `retry_task`, `send_message`,
`fork`, `refresh_timers`, `_dispatch`) but owns none of their state beyond the store
and runner it is handed via `WorkflowService`. `WorkflowService._sync_children` is a
one-line delegator to `sync_children` below -- it stays a real method (not inlined at
call sites) so `tests/test_event_subprocess.py`'s direct call and
`app/sync_children.py`'s wrapper keep working unchanged.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from SpiffWorkflow.bpmn.specs.mixins.subworkflow_task import CallActivity as CallActivityMixin
from SpiffWorkflow.bpmn.specs.mixins.subworkflow_task import SubWorkflowTask as SubWorkflowTaskMixin
from SpiffWorkflow.task import TaskState

if TYPE_CHECKING:
    from app.workflow_service import WorkflowService


def sync_children(service: WorkflowService, root_workflow_id: str, record: dict[str, Any]) -> None:
    root_workflow = record.get("workflow")
    if root_workflow is None:
        service.store.save(root_workflow_id, record)
        return

    # Must live in workflow.data, not record["data"]: runner.record() rebuilds
    # record["data"] from workflow.data on every save, so a map kept on the record
    # was silently discarded and every sync minted a fresh child record.
    children_map = root_workflow.data.setdefault("__children", {})

    def _sync(parent_id: str, parent_wf: Any, parent_bpmn_path: str) -> None:
        # One level at a time: the iterator descends into subprocesses by default,
        # which would attribute grandchildren to the root instead of their parent.
        for task in parent_wf.get_tasks(state=TaskState.ANY_MASK, skip_subprocesses=True):
            # isinstance, not name matching: this must also catch event/ad-hoc/transaction
            # subprocesses, not just CallActivity. Note SpiffWorkflow 3.2.0 does not
            # actually construct these as the EventSubprocess class its own parser table
            # names for that purpose (SubWorkflowParser.create_task()'s triggeredByEvent
            # check reads the BPMN-namespaced attribute, but the attribute is always
            # unprefixed on a standard <bpmn:subProcess triggeredByEvent="true">, so it
            # never matches) -- every triggeredByEvent subprocess is actually the plain
            # SubWorkflowTask class. isinstance against the shared base is what actually
            # works here, and is the same check SpiffWorkflow's own BpmnParser uses
            # internally for "does this task launch a subworkflow".
            if not isinstance(task.task_spec, SubWorkflowTaskMixin):
                continue
            # `task.workflow` is the workflow *containing* the launching task; the
            # subprocess it launched lives in top_workflow.subprocesses.
            child_wf = service.runner.subprocess_of(root_workflow, task)
            if child_wf is None:
                continue

            task_id = str(task.id)
            if task_id not in children_map:
                children_map[task_id] = uuid.uuid4().hex
            child_id = children_map[task_id]

            called = getattr(task.task_spec, "spec", "") or getattr(task.task_spec, "calledElement", "")
            if isinstance(task.task_spec, CallActivityMixin):
                bpmn_path = f"workflows/{called}.bpmn" if called else "unknown"
            else:
                # Inline subprocess (event subprocess, ad-hoc, transaction): there is no
                # separate called file -- the child's diagram genuinely is the file that
                # contains it.
                bpmn_path = parent_bpmn_path or "unknown"

            child_record = service.store.load(child_id)
            if not child_record:
                child_record = service.runner.record(
                    child_id,
                    child_wf,
                    bpmn_path,
                    called or "unknown",
                    service._status(child_wf),
                    jobs={},
                    save_points=[],
                    events=[],
                    parent_workflow_id=parent_id,
                )
            else:
                child_record["workflow"] = child_wf
                child_record["status"] = service._status(child_wf)
                child_record["tasks"] = service.runner.task_snapshot(child_wf)
                child_record["data"] = dict(child_wf.data)
                child_record["bpmn_path"] = bpmn_path
                child_record["process_id"] = called or "unknown"
                child_record["parent_workflow_id"] = parent_id

            service.store.save(child_id, child_record)
            _sync(child_id, child_wf, bpmn_path)

    _sync(root_workflow_id, root_workflow, record.get("bpmn_path", "unknown"))
    service.store.save(root_workflow_id, record)
