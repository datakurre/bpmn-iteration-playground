from __future__ import annotations

from typing import Any

from SpiffWorkflow.bpmn.workflow import BpmnWorkflow
from SpiffWorkflow.task import TaskState

from bpmn_agent.engine import WorkflowRunner


def _load_any_workflow() -> BpmnWorkflow:
    wf, _ = WorkflowRunner().load_workflow("workflows/contract_review.bpmn")
    return wf


def _workflow_parked_on_message_catch() -> BpmnWorkflow:
    wf, _ = WorkflowRunner().load_workflow("workflows/external_gate.bpmn")
    wf.do_engine_steps()
    for _ in range(20):
        if wf.waiting_events():
            break
        targets = [t for t in wf.get_tasks() if t.has_state(TaskState.READY | TaskState.STARTED)]
        if not targets:
            break
        for t in targets:
            t.set_data(agent_status="success", status="success")
            t.complete()
        wf.do_engine_steps()
    return wf


def test_migrate_reattaches_missing_320_attributes() -> None:
    from bpmn_agent.migrations import migrate_workflow_object

    wf = _load_any_workflow()
    del wf.event_manager
    del wf.task_removed_event
    del wf.spec.start.trigger_specs

    migrate_workflow_object(wf)

    assert hasattr(wf, "event_manager")
    assert hasattr(wf, "task_removed_event")
    assert wf.spec.start.trigger_specs == []
    wf.do_engine_steps()


def test_migrate_reregisters_waiting_catch_events() -> None:
    from bpmn_agent.migrations import migrate_workflow_object

    wf = _workflow_parked_on_message_catch()
    assert wf.waiting_events()
    del wf.event_manager
    migrate_workflow_object(wf)
    names = [e.name for e in wf.waiting_events()]
    assert "external_approval" in names


def test_migrate_is_idempotent_on_fresh_workflow() -> None:
    from bpmn_agent.migrations import migrate_workflow_object

    wf = _load_any_workflow()
    wf.do_engine_steps()

    reregistered_first = migrate_workflow_object(wf)
    reregistered_second = migrate_workflow_object(wf)

    assert reregistered_first == reregistered_second


def test_store_load_migrates_legacy_workflow(store: Any) -> None:
    wf = _workflow_parked_on_message_catch()

    store.save("wf1", {
        "workflow_id": "wf1",
        "process_id": "external_gate",
        "bpmn_path": "workflows/external_gate.bpmn",
        "status": "running",
        "workflow": wf,
        "data": {},
        "tasks": [],
        "save_points": [],
    })

    stored = store.load("wf1")
    assert stored is not None
    del stored["workflow"].event_manager  # simulate what unpickling an old object gives you

    loaded = store.load("wf1")
    assert loaded is not None
    loaded_workflow = loaded["workflow"]
    loaded_workflow.do_engine_steps()  # must not raise
    names = [e.name for e in loaded_workflow.waiting_events()]
    assert "external_approval" in names


def test_store_load_save_point_migrates_legacy_workflow(store: Any) -> None:
    wf = _workflow_parked_on_message_catch()

    store.save_save_point({
        "id": "sp1",
        "workflow_id": "wf1",
        "key": "checkpoint",
        "phase": "running",
        "resume_action": "",
        "task_id": "",
        "task_name": "",
        "status": "running",
        "created_at": "2026-08-21T00:00:00+00:00",
        "data": {},
        "tasks": [],
        "workflow": wf,
    })

    stored = store.load_save_point("sp1")
    assert stored is not None
    del stored["workflow"].event_manager  # simulate what unpickling an old object gives you

    loaded = store.load_save_point("sp1")
    assert loaded is not None
    loaded_workflow = loaded["workflow"]
    loaded_workflow.do_engine_steps()  # must not raise
    names = [e.name for e in loaded_workflow.waiting_events()]
    assert "external_approval" in names
