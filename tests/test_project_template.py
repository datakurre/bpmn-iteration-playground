from __future__ import annotations

import asyncio

import pytest

from bpmn_agent.adapters.mock_adapter import MockAdapter
from bpmn_agent.engine import WorkflowRunner
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.registry import WorkflowRegistry
from bpmn_agent.workflow_service import WorkflowService

BPMN_PATH = "workflows/project.bpmn"


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


def test_project_template_is_registered() -> None:
    templates = WorkflowRegistry().list_templates()
    assert any(t.id == "project" for t in templates)


def test_project_template_parses_and_declares_a_spawner() -> None:
    wf, pid = WorkflowRunner().load_workflow(BPMN_PATH)
    assert pid == "project"
    wf.do_engine_steps()
    assert wf.spec.start.trigger_specs, "no event subprocess registered as a trigger"


async def _start(service: WorkflowService) -> str:
    started = await service.start(BPMN_PATH, None, {"objective": "build a thing"})
    return started["workflow_id"]


@pytest.mark.anyio
async def test_project_spawns_a_child_per_spawn_message() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    wf_id = await _start(service)
    for i in range(3):
        await service.send_message(wf_id, "spawn_requested", {"task_brief": f"child {i}"})
    record = service.store.load(wf_id)
    assert record is not None
    children = record["workflow"].data["__children"]
    assert len(children) == 3


@pytest.mark.anyio
async def test_project_stays_open_after_children_finish() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    wf_id = await _start(service)
    await service.send_message(wf_id, "spawn_requested", {"task_brief": "first child"})

    async def _wait() -> None:
        while any(not j.done() for j in list(service.jobs.values())):
            pending = [j for j in list(service.jobs.values()) if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_wait(), timeout=5.0)

    record = service.store.load(wf_id)
    assert record is not None
    assert record["status"] != "completed"

    # still accepts a further spawn after the first child completed
    await service.send_message(wf_id, "spawn_requested", {"task_brief": "second child"})
    record_again = service.store.load(wf_id)
    assert record_again is not None
    assert len(record_again["workflow"].data["__children"]) == 2
    assert record_again["status"] != "completed"


@pytest.mark.anyio
async def test_spawn_payload_reaches_the_child() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    wf_id = await _start(service)
    await service.send_message(wf_id, "spawn_requested", {"task_brief": "do the thing"})

    record = service.store.load(wf_id)
    assert record is not None
    child_id = next(iter(record["workflow"].data["__children"].values()))
    child = service.store.load(child_id)
    assert child is not None
    assert child["data"].get("task_brief") == "do the thing"


class PromptCapturingAdapter(MockAdapter):
    """Records what the agent actually receives, not just what the child record ends up with."""

    def __init__(self) -> None:
        super().__init__()
        self.prompts: list[str] = []

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt, config, cwd, on_event=None):  # type: ignore[no-untyped-def]
        self.prompts.append(prompt)
        return await super().run(prompt, config, cwd, on_event)


@pytest.mark.anyio
async def test_spawn_payload_is_visible_in_the_childs_own_prompt() -> None:
    """The child's agent turn must see the brief in its own prompt, not just after the fact.

    runner.prompt() resolves camunda:inputParameter expressions against the *subprocess's*
    workflow.data, not the triggering task's task data that BpmnEvent.payload lands on by
    default -- a freshly spawned subprocess's workflow.data starts empty, so without
    send_message() also copying the payload there, the agent's prompt shows task_brief as
    null even though the completed child's own record eventually shows the real value (via
    SpiffWorkflow's terminal-task data merge). See send_message()'s comment for the mechanism.
    """
    adapter = PromptCapturingAdapter()
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    service.registry.register(adapter)
    wf_id = await _start(service)
    await service.send_message(wf_id, "spawn_requested", {"task_brief": "do the thing"})

    async def _wait() -> None:
        while any(not j.done() for j in list(service.jobs.values())):
            pending = [j for j in list(service.jobs.values()) if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_wait(), timeout=5.0)

    assert len(adapter.prompts) == 1
    assert '"task_brief": "do the thing"' in adapter.prompts[0]
