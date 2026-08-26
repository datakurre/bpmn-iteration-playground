from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from graph_agent.adapters.mock_adapter import MockAdapter
from graph_agent.engine import WorkflowRunner
from graph_agent.models import ExtendRequest
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService

BPMN_PATH = Path("graph_agent/data/workflows/bootstrap.bpmn")


def _find_ready_task(state: dict[str, Any], bpmn_id: str) -> dict[str, Any]:
    return next(t for t in state["tasks"] if t["bpmn_id"] == bpmn_id and t["state"] == "READY")


def test_bootstrap_template_loads() -> None:
    """bootstrap.bpmn loads without errors."""
    runner = WorkflowRunner()
    workflow, pid = runner.load_workflow(str(BPMN_PATH))
    assert pid == "Process_Bootstrap"
    assert "UserTask_Prompt" in workflow.spec.task_specs
    assert "ServiceTask_Extend" in workflow.spec.task_specs
    assert "ServiceTask_Migrate" in workflow.spec.task_specs


@pytest.mark.anyio
async def test_bootstrap_starts_at_prompt(tmp_path: Path) -> None:
    """Starting the bootstrap workflow parks at UserTask_Prompt."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        state = await service.start(str(BPMN_PATH))
        assert state["status"] == "waiting_human"
        prompt_tasks = [
            t
            for t in state["tasks"]
            if t["bpmn_id"] == "UserTask_Prompt" and t["state"] == "READY"
        ]
        assert len(prompt_tasks) == 1
    finally:
        store.close()


@pytest.mark.anyio
async def test_bootstrap_prompt_to_extend(tmp_path: Path) -> None:
    """Submitting the prompt triggers the graph_architect agent."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter(
            output={
                "status": "success",
                "summary": "Designed 1 task extension",
                "findings": [
                    {
                        "after": "ServiceTask_Migrate",
                        "nodes": [
                            {
                                "bpmn_id": "Task_Custom_Step",
                                "name": "Custom Step",
                                "element_type": "serviceTask",
                                "properties": {"harness_type": "mock"},
                            }
                        ],
                    }
                ],
                "artifacts": [],
                "next_action": "continue",
            }
        )
        service.registry.bind("pi_agent", mock)

        state = await service.start(str(BPMN_PATH))
        wf_id = state["workflow_id"]
        prompt_task = _find_ready_task(state, "UserTask_Prompt")

        await service.submit_task(wf_id, prompt_task["id"], {"goal": "Write tests"})

        # Wait for extend agent turn
        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        # Should now be waiting at UserTask_EditGraph
        state2 = service.state(wf_id)
        assert state2["status"] == "waiting_human"
        edit_task = next(t for t in state2["tasks"] if t["bpmn_id"] == "UserTask_EditGraph")
        assert edit_task["state"] == "READY"
    finally:
        store.close()


def test_bootstrap_extend_produces_valid_extension() -> None:
    """The mock graph_architect output is a valid ExtendRequest."""
    raw_extension = {
        "after": "UserTask_Prompt",
        "nodes": [
            {
                "bpmn_id": "Task_Analyze",
                "name": "Analyze Scope",
                "element_type": "serviceTask",
                "properties": {"harness_type": "pi_agent", "agent_role": "analyzer"},
                "input_params": {"goal": "${goal}"},
                "output_params": {"status": "${status}"},
            }
        ],
    }
    req = ExtendRequest.model_validate(raw_extension)
    assert req.after == "UserTask_Prompt"
    assert len(req.nodes) == 1
    assert req.nodes[0].bpmn_id == "Task_Analyze"


@pytest.mark.anyio
async def test_bootstrap_full_cycle(tmp_path: Path) -> None:
    """Full cycle: prompt -> extend -> edit(approve) -> execute -> back to prompt."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter(
            output={
                "status": "success",
                "summary": "Designed custom plan",
                "findings": [
                    {
                        "after": "ServiceTask_Migrate",
                        "nodes": [
                            {
                                "bpmn_id": "Task_Execute_Code",
                                "name": "Execute Code",
                                "element_type": "serviceTask",
                                "properties": {"harness_type": "mock"},
                            }
                        ],
                    }
                ],
                "artifacts": [],
                "next_action": "continue",
            }
        )
        service.registry.bind("pi_agent", mock)
        service.registry.bind("mock", mock)

        # 1. Start
        state = await service.start(str(BPMN_PATH))
        wf_id = state["workflow_id"]

        # 2. Submit prompt
        prompt_task = _find_ready_task(state, "UserTask_Prompt")
        await service.submit_task(wf_id, prompt_task["id"], {"goal": "Analyze code"})

        # 3. Wait for architect agent
        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        # 4. Edit gate: approve
        state2 = service.state(wf_id)
        edit_task = _find_ready_task(state2, "UserTask_EditGraph")
        await service.submit_task(wf_id, edit_task["id"], {"approval": "apply"})

        # 5. Wait for GraphExtendAdapter and inserted Task_Execute_Code to run
        while any(not j.done() for j in service.jobs.values()):
            await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])
            await asyncio.sleep(0.01)

        # 6. Should loop back to UserTask_Prompt
        final_state = service.state(wf_id)
        assert final_state["status"] == "waiting_human"
        prompt_tasks = [
            t
            for t in final_state["tasks"]
            if t["bpmn_id"] == "UserTask_Prompt" and t["state"] == "READY"
        ]
        assert len(prompt_tasks) == 1
    finally:
        store.close()


@pytest.mark.anyio
async def test_bootstrap_reject_loops_back(tmp_path: Path) -> None:
    """Rejecting the extension loops back to prompt without modifying the graph."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter(
            output={
                "status": "success",
                "summary": "Plan to reject",
                "findings": [
                    {
                        "after": "ServiceTask_Migrate",
                        "nodes": [
                            {
                                "bpmn_id": "Task_Not_Wanted",
                                "name": "Not Wanted",
                                "element_type": "serviceTask",
                            }
                        ],
                    }
                ],
                "artifacts": [],
                "next_action": "continue",
            }
        )
        service.registry.bind("pi_agent", mock)

        state = await service.start(str(BPMN_PATH))
        wf_id = state["workflow_id"]

        prompt_task = _find_ready_task(state, "UserTask_Prompt")
        await service.submit_task(wf_id, prompt_task["id"], {"goal": "Discard this"})

        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        state2 = service.state(wf_id)
        edit_task = _find_ready_task(state2, "UserTask_EditGraph")
        await service.submit_task(wf_id, edit_task["id"], {"approval": "reject"})

        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        # Looped back to prompt
        state3 = service.state(wf_id)
        assert state3["status"] == "waiting_human"
        ready_prompt = _find_ready_task(state3, "UserTask_Prompt")
        assert ready_prompt is not None
        # Verify Task_Not_Wanted was not inserted
        assert not any(t["bpmn_id"] == "Task_Not_Wanted" for t in state3["tasks"])
    finally:
        store.close()


@pytest.mark.anyio
async def test_bootstrap_agent_failure_shows_retry(tmp_path: Path) -> None:
    """When the architect agent fails, the retry gate is shown."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter(
            output={
                "status": "failed",
                "summary": "Could not understand goal",
                "findings": [],
                "artifacts": [],
                "next_action": "abort",
            }
        )
        service.registry.bind("pi_agent", mock)

        state = await service.start(str(BPMN_PATH))
        wf_id = state["workflow_id"]

        prompt_task = _find_ready_task(state, "UserTask_Prompt")
        await service.submit_task(wf_id, prompt_task["id"], {"goal": "Unknown request"})

        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        # Should be waiting at UserTask_Retry
        state2 = service.state(wf_id)
        assert state2["status"] == "waiting_human"
        retry_task = _find_ready_task(state2, "UserTask_Retry")
        assert retry_task is not None

        # Change mock to succeed on retry
        mock.output = {
            "status": "success",
            "summary": "Plan now succeeded",
            "findings": [
                {
                    "after": "ServiceTask_Migrate",
                    "nodes": [{"bpmn_id": "Task_New", "name": "New", "element_type": "serviceTask"}],
                }
            ],
            "artifacts": [],
            "next_action": "continue",
        }

        # Submit retry
        await service.submit_task(wf_id, retry_task["id"], {"goal": "Clarified goal"})
        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        state3 = service.state(wf_id)
        assert state3["status"] == "waiting_human"
        edit_task = _find_ready_task(state3, "UserTask_EditGraph")
        assert edit_task is not None
    finally:
        store.close()


@pytest.mark.anyio
async def test_current_spec_available_to_agent(tmp_path: Path) -> None:
    """The __current_spec variable contains the workflow's BPMN XML."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        received_prompts: list[str] = []

        class InspectingMock(MockAdapter):
            async def run(
                self,
                prompt: str,
                config: dict[str, str],
                cwd: str,
                on_event: Any = None,
            ) -> Any:
                received_prompts.append(prompt)
                return await super().run(prompt, config, cwd, on_event)

        mock = InspectingMock()
        service.registry.bind("pi_agent", mock)

        state = await service.start(str(BPMN_PATH))
        wf_id = state["workflow_id"]

        prompt_task = _find_ready_task(state, "UserTask_Prompt")
        await service.submit_task(wf_id, prompt_task["id"], {"goal": "Check spec injection"})

        if service.jobs:
            await asyncio.gather(*[j for j in service.jobs.values() if not j.done()])

        assert len(received_prompts) >= 1
        # Check that __current_spec was resolved into prompt
        prompt_text = received_prompts[0]
        assert "Process_Bootstrap" in prompt_text
        assert "bpmn:definitions" in prompt_text
    finally:
        store.close()


def test_bootstrap_template_discovered_by_registry() -> None:
    """bootstrap.bpmn is auto-discovered by WorkflowRegistry."""
    from graph_agent.registry import WorkflowRegistry

    registry = WorkflowRegistry()
    templates = registry.list_templates()
    bootstrap = next((t for t in templates if t.id == "Process_Bootstrap" or Path(t.path).stem == "bootstrap"), None)
    assert bootstrap is not None
    assert bootstrap.name == "Self-Extending Bootstrap Loop"


@pytest.mark.anyio
async def test_bootstrap_multiple_extension_cycles(tmp_path: Path) -> None:
    """The graph can be extended multiple times across multiple cycles."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        mock = MockAdapter()
        service.registry.bind("pi_agent", mock)
        service.registry.bind("mock", mock)

        state = await service.start(str(BPMN_PATH))
        wf_id = state["workflow_id"]

        for cycle in range(2):
            mock.output = {
                "status": "success",
                "summary": f"Plan cycle {cycle}",
                "findings": [
                    {
                        "after": "ServiceTask_Migrate",
                        "nodes": [
                            {
                                "bpmn_id": f"Task_Cycle_{cycle}",
                                "name": f"Cycle {cycle}",
                                "element_type": "serviceTask",
                                "properties": {"harness_type": "mock"},
                            }
                        ],
                    }
                ],
                "artifacts": [],
                "next_action": "continue",
            }

            # 1. Prompt
            prompt_task = _find_ready_task(state, "UserTask_Prompt")
            await service.submit_task(wf_id, prompt_task["id"], {"goal": f"Cycle {cycle}"})

            # 2. Architect
            while any(not j.done() for j in service.jobs.values()):
                await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])
                await asyncio.sleep(0.01)

            # 3. Edit gate
            state2 = service.state(wf_id)
            edit_task = _find_ready_task(state2, "UserTask_EditGraph")
            await service.submit_task(wf_id, edit_task["id"], {"approval": "apply"})

            # 4. Migrate & Execute
            while any(not j.done() for j in service.jobs.values()):
                await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])
                await asyncio.sleep(0.01)

            state = service.state(wf_id)
            assert state["status"] == "waiting_human"
            assert any(t["bpmn_id"] == f"Task_Cycle_{cycle}" for t in state["tasks"])

    finally:
        store.close()

