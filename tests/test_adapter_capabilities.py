from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from bpmn_agent.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter, resolve_timeout
from bpmn_agent.adapters.registry import AdapterRegistry
from bpmn_agent.adapters.shell_adapter import ShellAdapter
from bpmn_agent.api.server import create_app
from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.workflow_service import WorkflowService

BEAMER = "bpmn_agent/data/workflows/beamer_slides.bpmn"
BRIEF = {"topic": "adapters", "audience": "engineers", "duration_minutes": 10}


class FakePi:
    """A Pi-shaped client; the service wraps it in its GenericAdapter."""

    def __init__(self) -> None:
        self.sessions: list[str | None] = []

    async def run(self, prompt: str, cwd: str, session_id: str | None = None, fork: bool = False) -> PiResult:
        self.sessions.append(session_id)
        return PiResult(
            "success",
            {"status": "success", "summary": "ok", "findings": [], "artifacts": [], "next_action": "continue"},
            "ok",
            [],
            "",
            0,
            session_id="sess-1",
        )


def test_base_adapter_defaults_to_a_conservative_declaration() -> None:
    class Bare(BaseAdapter):
        @property
        def adapter_type(self) -> str:
            return "bare"

        async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
            return AgentResult("success", {}, "")

    caps = Bare().capabilities
    assert caps.display_name == "bare"
    assert caps.supports_sessions is False


def test_shell_declares_itself_sessionless_and_prompt_free() -> None:
    caps = ShellAdapter().capabilities
    assert caps.supports_sessions is False
    assert caps.consumes_prompt is False
    assert caps.view == "console"


def test_pi_declares_sessions_and_a_provider_hint() -> None:
    adapter = AdapterRegistry(auto_discover=False).get("pi_agent")
    assert adapter is not None
    caps = adapter.capabilities
    assert caps.supports_sessions is True
    assert caps.no_output_hint and "PI_MODEL" in caps.no_output_hint


def test_shell_timeout_comes_from_its_declared_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SHELL_TIMEOUT_SECONDS", "42")
    assert ShellAdapter().timeout_seconds == 42.0
    assert ShellAdapter(timeout_seconds=7).timeout_seconds == 7.0


def test_resolve_timeout_ignores_an_unparseable_env_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOGUS_TIMEOUT", "not-a-number")
    caps = AdapterCapabilities(display_name="x", timeout_env_var="BOGUS_TIMEOUT", default_timeout_seconds=11.0)
    assert resolve_timeout(caps) == 11.0


def test_replace_rebinds_every_alias_of_the_previous_instance() -> None:
    registry = AdapterRegistry(auto_discover=False)
    original = registry.get("sandbox_pi")
    assert registry.get("agent_sandbox") is original

    replacement = type(original)()  # type: ignore[misc]
    registry.replace(replacement)

    # A plain register() would have left the alias on the old instance.
    assert registry.get("sandbox_pi") is replacement
    assert registry.get("agent_sandbox") is replacement


def test_plugin_importing_a_builtin_adapter_does_not_re_register_it(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin = tmp_path / "importer.py"
    plugin.write_text("from bpmn_agent.adapters.shell_adapter import ShellAdapter\n")
    monkeypatch.setenv("ADAPTER_PLUGINS", str(tmp_path))

    registry = AdapterRegistry(auto_discover=False)
    before = registry.get("shell")
    assert registry.discover_plugins() == 0
    assert registry.get("shell") is before


@pytest.mark.anyio
async def test_unregistered_harness_fails_instead_of_falling_back_to_pi() -> None:
    """A shell task must never have its prompt quietly run through the agent."""
    registry = AdapterRegistry(auto_discover=False)
    del registry._adapters["shell"]
    service = WorkflowService(WorkflowStore(":memory:"), FakePi(), adapter_registry=registry)

    state = await service.start(BEAMER, None, dict(BRIEF))
    workflow_id = state["workflow_id"]
    while any(not job.done() for job in list(service.jobs.values())):
        await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])
    state = service.state(workflow_id)
    task_id = next(t["id"] for t in state["tasks"] if t["bpmn_id"] == "Task_Review_Outline")
    await service.submit_task(workflow_id, task_id, {"outline_decision": "approved"})

    state = service.state(workflow_id)
    assert state["status"] == "failed"
    assert "shell" in (state.get("failure_reason") or "")


@pytest.mark.anyio
async def test_a_shell_turn_does_not_hold_an_agent_session() -> None:
    """The bug this surface exists for: a build step must not join session threading.

    Holding an inherited id made a shell job register as a colliding sibling, forcing
    parallel agent turns to fork their session for nothing.
    """
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    state = await service.start(BEAMER, None, dict(BRIEF))
    workflow_id = state["workflow_id"]
    while any(not job.done() for job in list(service.jobs.values())):
        await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])
    state = service.state(workflow_id)
    task_id = next(t["id"] for t in state["tasks"] if t["bpmn_id"] == "Task_Review_Outline")
    await service.submit_task(workflow_id, task_id, {"outline_decision": "approved"})

    record = service.store.load(workflow_id)
    assert record is not None
    shell_jobs = [j for j in record["jobs"].values() if j.get("task_name") == "Prepare Workspace"]
    assert shell_jobs, "the scaffold shell task never ran"
    assert all(job.get("session_id") is None for job in shell_jobs)
    assert all(job.get("session_fork") is False for job in shell_jobs)


def test_harnesses_endpoint_reports_each_declaration() -> None:
    client = TestClient(create_app(WorkflowService(WorkflowStore(":memory:"))))
    by_type = {h["harness_type"]: h for h in client.get("/api/harnesses").json()}

    assert by_type["shell"]["view"] == "console"
    assert by_type["shell"]["supports_sessions"] is False
    assert by_type["pi_agent"]["view"] == "agent"
    assert by_type["pi_agent"]["supports_sessions"] is True
