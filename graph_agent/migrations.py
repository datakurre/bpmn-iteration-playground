"""Reattach attributes that SpiffWorkflow 3.2.0 added to ``__init__`` but that
unpickling (which never calls ``__init__``) leaves missing on objects persisted
under 3.1.2. See todos/01-spiffworkflow-320-upgrade.md for the verified
attribute surface.
"""

from __future__ import annotations

from typing import Any

from SpiffWorkflow.bpmn.specs.mixins.events.event_types import CatchingEvent
from SpiffWorkflow.bpmn.util.event import EventManager
from SpiffWorkflow.task import TaskState
from SpiffWorkflow.util.event import Event


def _migrate_workflow_attrs(wf: Any) -> None:
    if not hasattr(wf, "event_manager"):
        wf.event_manager = EventManager(wf)
    if not hasattr(wf, "task_removed_event"):
        wf.task_removed_event = Event()


def _migrate_spec_attrs(spec: Any) -> None:
    start = getattr(spec, "start", None)
    if start is not None and not hasattr(start, "trigger_specs"):
        start.trigger_specs = []


def migrate_workflow_object(wf: Any) -> int:
    """Reattach missing 3.2.0 attributes to a workflow object and its
    subprocesses/subprocess specs, then re-register any catching tasks that
    are parked on an event so ``waiting_events()`` reports them again.

    Idempotent and a no-op on workflows already created under 3.2.0, and on
    anything that isn't a real ``BpmnWorkflow`` (e.g. mock/dummy workflow
    payloads used in tests). Returns the number of catching tasks
    re-registered.
    """
    if getattr(wf, "spec", None) is None:
        return 0

    _migrate_workflow_attrs(wf)
    for subprocess in getattr(wf, "subprocesses", {}).values():
        _migrate_workflow_attrs(subprocess)

    _migrate_spec_attrs(wf.spec)
    for subprocess_spec in getattr(wf, "subprocess_specs", {}).values():
        _migrate_spec_attrs(subprocess_spec)

    reregistered = 0
    for task in wf.get_tasks():
        if isinstance(task.task_spec, CatchingEvent) and task.has_state(TaskState.DEFINITE_MASK):
            task.workflow.top_workflow.event_manager.add_task(task)
            reregistered += 1
    return reregistered
