from __future__ import annotations

import pytest
from SpiffWorkflow.bpmn.specs.event_definitions.message import MessageEventDefinition
from SpiffWorkflow.bpmn.util import BpmnEvent

from graph_agent.engine import WorkflowRunner
from graph_agent.persistence import WorkflowStore
from graph_agent.pi_client import PiResult
from graph_agent.workflow_service import WorkflowService

FIXTURE = "tests/fixtures/event_subprocess_spawn.bpmn"


class FakePi:
    async def run(self, prompt: str, cwd: str) -> PiResult:
        return PiResult(
            "success",
            {"status": "success", "summary": "complete", "findings": [], "artifacts": [], "next_action": "continue"},
            "result",
            [],
            "",
            0,
        )


def test_event_subprocess_spawns_a_child_per_message() -> None:
    wf, _ = WorkflowRunner().load_workflow(FIXTURE)
    wf.do_engine_steps()
    assert wf.spec.start.trigger_specs == ["Child"]
    for _ in range(3):
        wf.catch(BpmnEvent(MessageEventDefinition("spawn_requested"), payload={}))
        wf.do_engine_steps()
    assert len(wf.subprocesses) == 3


async def _start(service: WorkflowService) -> str:
    started = await service.start(FIXTURE, None, {})
    return started["workflow_id"]


@pytest.mark.anyio
async def test_event_subprocess_children_are_synced() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    wf_id = await _start(service)
    await service.send_message(wf_id, "spawn_requested", {})

    record = service.store.load(wf_id)
    assert record is not None
    children = record["workflow"].data.get("__children", {})
    assert len(children) == 1, "spawned child was not synced"

    child_id = next(iter(children.values()))
    child = service.store.load(child_id)
    assert child is not None
    assert child["parent_workflow_id"] == wf_id
    # No calledElement for an inline event subprocess: the child's diagram is the parent's file.
    assert child["bpmn_path"] == FIXTURE


@pytest.mark.anyio
async def test_multiple_spawned_children_get_distinct_records() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    wf_id = await _start(service)

    for _ in range(3):
        await service.send_message(wf_id, "spawn_requested", {})

    record = service.store.load(wf_id)
    assert record is not None
    children = record["workflow"].data["__children"]
    assert len(children) == 3
    assert len(set(children.values())) == 3

    ids_before = dict(children)

    # A re-sync must not mint new ids for the same spawned tasks.
    service._sync_children(wf_id, service._record(wf_id))
    record_again = service.store.load(wf_id)
    assert record_again is not None
    assert record_again["workflow"].data["__children"] == ids_before


@pytest.mark.anyio
async def test_parent_stays_active_while_children_run() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    wf_id = await _start(service)
    await service.send_message(wf_id, "spawn_requested", {})

    record = service.store.load(wf_id)
    assert record is not None
    assert record["status"] != "completed"

    main_task = next(t for t in record["tasks"] if t["bpmn_id"] == "Task_Main")
    assert main_task["state"] == "READY"


@pytest.mark.anyio
async def test_spawned_children_are_discoverable_via_the_api() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    wf_id = await _start(service)
    await service.send_message(wf_id, "spawn_requested", {})

    state = service.state(wf_id)
    record = service.store.load(wf_id)
    assert record is not None
    child_id = next(iter(record["workflow"].data["__children"].values()))

    # Discoverable the same way CallActivity children already are (tests/test_subprocess.py):
    # a metadata row exists for the child, back-referencing its parent via parent_workflow_id.
    matches = [i for i in service.history_instances() if i["workflow_id"] == child_id]
    assert len(matches) == 1
    assert matches[0]["parent_workflow_id"] == wf_id
    assert state["status"] != "completed"
