from __future__ import annotations

from typing import Any
from SpiffWorkflow.bpmn.specs.defaults import CallActivity
from SpiffWorkflow.task import TaskState


def sync_children(service: Any, root_workflow_id: str) -> None:
    root_record = service.store.load(root_workflow_id)
    if not root_record:
        return

    visited: set[str] = set()

    def _sync(parent_id: str, parent_wf: Any) -> None:
        if parent_id in visited:
            return
        visited.add(parent_id)

        children_map = root_record.get("data", {}).setdefault("__children", {})

        for task in parent_wf.get_tasks(state=TaskState.ANY_MASK):
            is_call = isinstance(task.task_spec, CallActivity) or type(task.task_spec).__name__ == "CallActivity"
            if is_call and hasattr(task, "workflow") and task.workflow:
                task_id = str(task.id)
                if task_id not in children_map:
                    import uuid
                    children_map[task_id] = uuid.uuid4().hex

                child_id = children_map[task_id]
                child_wf = task.workflow

                # Create or update child record
                child_record = service.store.load(child_id)
                if not child_record:
                    child_record = service.runner.record(
                        child_id,
                        child_wf,
                        "calledElement",  # we can extract from task_spec
                        "calledElement",
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

                # set bpmn path properly
                called = getattr(task.task_spec, "calledElement", "")
                if called:
                    child_record["bpmn_path"] = f"workflows/{called}.bpmn"
                    child_record["process_id"] = called

                service.store.save(child_id, child_record)

                # Recurse
                _sync(child_id, child_wf)

    _sync(root_workflow_id, root_record["workflow"])
    # Save the root to persist the __children map
    service.store.save(root_workflow_id, root_record)

