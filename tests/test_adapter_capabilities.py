from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graph_agent.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter, resolve_timeout
from graph_agent.adapters.registry import AdapterRegistry
from graph_agent.adapters.shell_adapter import ShellAdapter
from graph_agent.api.server import create_app
from graph_agent.persistence import WorkflowStore
from graph_agent.pi_client import PiResult
from graph_agent.workflow_service import WorkflowService


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
    original = ShellAdapter()
    registry.bind("shell", original)
    registry.bind("shell_alias", original)

    assert registry.get("shell_alias") is original

    replacement = ShellAdapter()
    registry.replace(replacement)

    assert registry.get("shell") is replacement
    assert registry.get("shell_alias") is replacement


def test_plugin_importing_a_builtin_adapter_does_not_re_register_it(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    plugin = tmp_path / "importer.py"
    plugin.write_text("from graph_agent.adapters.shell_adapter import ShellAdapter\n")
    monkeypatch.setenv("ADAPTER_PLUGINS", str(tmp_path))

    registry = AdapterRegistry(auto_discover=False)
    before = registry.get("shell")
    assert registry.discover_plugins() == 0
    assert registry.get("shell") is before


SHELL_BPMN = """<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_ShellTest" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="shell_test" name="Shell Test" isExecutable="true">
    <bpmn:startEvent id="Start_1"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Agent_1" />
    <bpmn:serviceTask id="Task_Agent_1" name="Agent Step">
      <bpmn:extensionElements>
        <camunda:properties>
          <camunda:property name="harness_type" value="pi_agent" />
        </camunda:properties>
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_Agent_1" targetRef="Task_Shell_1" />
    <bpmn:serviceTask id="Task_Shell_1" name="Prepare Workspace">
      <bpmn:extensionElements>
        <camunda:properties>
          <camunda:property name="harness_type" value="shell" />
          <camunda:property name="command" value="echo prepared" />
        </camunda:properties>
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_2</bpmn:incoming>
      <bpmn:outgoing>Flow_3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_Shell_1" targetRef="End_1" />
    <bpmn:endEvent id="End_1"><bpmn:incoming>Flow_3</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>"""


@pytest.mark.anyio
async def test_unregistered_harness_fails_instead_of_falling_back_to_pi(tmp_path: Any) -> None:
    """A shell task must never have its prompt quietly run through the agent."""
    registry = AdapterRegistry(auto_discover=False)
    del registry._adapters["shell"]
    service = WorkflowService(WorkflowStore(":memory:"), FakePi(), adapter_registry=registry)

    bpmn_file = tmp_path / "shell_test.bpmn"
    bpmn_file.write_text(SHELL_BPMN, encoding="utf-8")

    state = await service.start(str(bpmn_file), "shell_test", {})
    workflow_id = state["workflow_id"]
    while any(not job.done() for job in list(service.jobs.values())):
        await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])

    state = service.state(workflow_id)
    assert state["status"] == "failed"
    assert "shell" in (state.get("failure_reason") or "")


@pytest.mark.anyio
async def test_a_shell_turn_does_not_hold_an_agent_session(tmp_path: Any) -> None:
    """The bug this surface exists for: a build step must not join session threading.

    Holding an inherited id made a shell job register as a colliding sibling, forcing
    parallel agent turns to fork their session for nothing.
    """
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    bpmn_file = tmp_path / "shell_test.bpmn"
    bpmn_file.write_text(SHELL_BPMN, encoding="utf-8")

    state = await service.start(str(bpmn_file), "shell_test", {})
    workflow_id = state["workflow_id"]
    while any(not job.done() for job in list(service.jobs.values())):
        await asyncio.gather(*[j for j in list(service.jobs.values()) if not j.done()])

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
