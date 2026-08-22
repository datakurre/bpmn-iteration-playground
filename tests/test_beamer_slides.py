from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.adapters.base import AgentResult
from app.adapters.shell_adapter import ShellAdapter
from app.engine import WorkflowRunner
from app.persistence import WorkflowStore
from app.pi_rpc import PiResult
from app.registry import WorkflowRegistry
from app.workflow_service import WorkflowService

BPMN_PATH = "workflows/beamer_slides.bpmn"
BRIEF = {"topic": "BPMN as an agent controller", "audience": "platform engineers", "duration_minutes": 20}


class FakePi:
    """Stands in for the Pi CLI; records the prompt each agent turn actually received."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def run(self, prompt: str, cwd: str) -> PiResult:
        self.prompts.append(prompt)
        return PiResult(
            "success",
            {
                "status": "success",
                "summary": "done",
                "findings": [],
                "artifacts": [],
                "next_action": "continue",
            },
            "result",
            [],
            "",
            0,
        )


class ScriptedShell(ShellAdapter):
    """Real scaffolding, scripted builds.

    `make pdf` / `make images` are replaced by queued exit codes so the graph can be
    exercised without a TeX Live toolchain; the `template` scaffold path runs for real.
    """

    def __init__(self, build_exit_codes: list[int] | None = None) -> None:
        super().__init__()
        self.build_exit_codes = list(build_exit_codes or [0])
        self.commands: list[str] = []

    async def run(
        self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None
    ) -> AgentResult:
        command = config.get("command", "")
        if not command:
            return await super().run(prompt, config, cwd, on_event)
        self.commands.append(command)
        exit_code = self.build_exit_codes.pop(0) if self.build_exit_codes else 0
        succeeded = exit_code == 0
        return AgentResult(
            status="success",
            output={
                "status": "success" if succeeded else "failed",
                "summary": f"`{command}` exited {exit_code}",
                "exit_code": exit_code,
                "stdout": "",
                "stderr": "",
                "log": "" if succeeded else "! Undefined control sequence.\nl.42 \\metropolisset",
                "findings": [],
                "artifacts": ["slides.pdf"] if succeeded else [],
                "next_action": "continue" if succeeded else "revise",
            },
            text=command,
            messages=[],
            stderr="",
            exit_code=exit_code,
        )


async def _settle(service: WorkflowService) -> None:
    """Drain every agent turn, including ones a loop-back spawns while draining."""
    async def _wait() -> None:
        while True:
            pending = [job for job in list(service.jobs.values()) if not job.done()]
            if not pending:
                return
            await asyncio.gather(*pending)
            await asyncio.sleep(0)

    await asyncio.wait_for(_wait(), timeout=10.0)


def _task_id(state: dict[str, Any], bpmn_id: str) -> str:
    return next(task["id"] for task in state["tasks"] if task["bpmn_id"] == bpmn_id)


async def _to_slide_loop(service: WorkflowService) -> str:
    """Start the deck and approve the outline, leaving the instance in the build loop."""
    state = await service.start(BPMN_PATH, None, dict(BRIEF))
    workflow_id = state["workflow_id"]
    await _settle(service)
    state = service.state(workflow_id)
    assert state["status"] == "waiting_human"
    await service.submit_task(
        workflow_id, _task_id(state, "Task_Review_Outline"), {"outline_decision": "approved"}
    )
    await _settle(service)
    return workflow_id


def test_template_is_registered_and_parses() -> None:
    assert any(t.id == "beamer_slides" for t in WorkflowRegistry().list_templates())
    _, process_id = WorkflowRunner().load_workflow(BPMN_PATH)
    assert process_id == "beamer_slides"


@pytest.mark.anyio
async def test_outline_is_settled_with_a_human_before_any_latex_exists() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    shell = ScriptedShell()
    service.registry.register(shell)

    state = await service.start(BPMN_PATH, None, dict(BRIEF))
    await _settle(service)
    state = service.state(state["workflow_id"])

    assert state["status"] == "waiting_human"
    assert state["data"]["plan_status"] == "success"
    # The workspace has not been scaffolded yet: planning happens before the toolchain.
    assert shell.commands == []


@pytest.mark.anyio
async def test_rejecting_the_outline_replans_instead_of_moving_on() -> None:
    pi = FakePi()
    service = WorkflowService(WorkflowStore(":memory:"), pi)
    service.registry.register(ScriptedShell())

    state = await service.start(BPMN_PATH, None, dict(BRIEF))
    workflow_id = state["workflow_id"]
    await _settle(service)
    state = service.state(workflow_id)

    await service.submit_task(
        workflow_id,
        _task_id(state, "Task_Review_Outline"),
        {"outline_decision": "revise", "outline_feedback": "too many slides on background"},
    )
    await _settle(service)

    assert len(pi.prompts) == 2
    assert "too many slides on background" in pi.prompts[1]
    assert service.state(workflow_id)["status"] == "waiting_human"


@pytest.mark.anyio
async def test_brief_is_interpolated_into_the_planning_prompt() -> None:
    pi = FakePi()
    service = WorkflowService(WorkflowStore(":memory:"), pi)
    service.registry.register(ScriptedShell())

    await service.start(BPMN_PATH, None, dict(BRIEF))
    await _settle(service)

    assert "20-minute talk on BPMN as an agent controller" in pi.prompts[0]
    assert "platform engineers" in pi.prompts[0]


@pytest.mark.anyio
async def test_approved_outline_scaffolds_the_pinned_toolchain_into_the_workspace() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    service.registry.register(ScriptedShell())

    workflow_id = await _to_slide_loop(service)
    files = {f["path"] for f in service.state(workflow_id)["workspace_metadata"]["files"]}

    assert {"Makefile", "flake.nix", "slides.tex"} <= files


@pytest.mark.anyio
async def test_a_clean_build_renders_images_and_waits_for_the_human() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    shell = ScriptedShell(build_exit_codes=[0, 0])
    service.registry.register(shell)

    workflow_id = await _to_slide_loop(service)
    state = service.state(workflow_id)

    assert shell.commands == ["make pdf", "make images"]
    assert state["data"]["build_status"] == "success"
    assert state["status"] == "waiting_human"
    assert any(task["bpmn_id"] == "Task_Review_Deck" for task in state["tasks"])


@pytest.mark.anyio
async def test_a_failed_compile_routes_back_to_the_agent_with_the_log() -> None:
    """The point of the deterministic harness: LaTeX failure is data, not a halt."""
    pi = FakePi()
    service = WorkflowService(WorkflowStore(":memory:"), pi)
    shell = ScriptedShell(build_exit_codes=[1, 0, 0])
    service.registry.register(shell)

    workflow_id = await _to_slide_loop(service)
    state = service.state(workflow_id)

    assert shell.commands == ["make pdf", "make pdf", "make images"]
    # plan + first slides attempt + repair attempt
    assert len(pi.prompts) == 3
    assert "Undefined control sequence" in pi.prompts[2]
    assert state["status"] == "waiting_human"
    assert state["data"]["build_status"] == "success"


@pytest.mark.anyio
async def test_requested_deck_changes_iterate_slides_without_replanning() -> None:
    pi = FakePi()
    service = WorkflowService(WorkflowStore(":memory:"), pi)
    shell = ScriptedShell(build_exit_codes=[0, 0, 0, 0])
    service.registry.register(shell)

    workflow_id = await _to_slide_loop(service)
    state = service.state(workflow_id)
    await service.submit_task(
        workflow_id,
        _task_id(state, "Task_Review_Deck"),
        {"deck_decision": "revise", "deck_feedback": "cut slide 4, the chart is unreadable"},
    )
    await _settle(service)

    assert shell.commands == ["make pdf", "make images", "make pdf", "make images"]
    assert "cut slide 4" in pi.prompts[-1]
    # the revision loop re-enters the slide task, never the planning task
    assert sum("Do not write LaTeX yet" in prompt for prompt in pi.prompts) == 1


@pytest.mark.anyio
async def test_approving_the_deck_completes_the_instance() -> None:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    service.registry.register(ScriptedShell(build_exit_codes=[0, 0]))

    workflow_id = await _to_slide_loop(service)
    state = service.state(workflow_id)
    completed = await service.submit_task(
        workflow_id, _task_id(state, "Task_Review_Deck"), {"deck_decision": "approved"}
    )

    assert completed["status"] == "completed"
