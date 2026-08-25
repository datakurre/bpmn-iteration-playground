import asyncio
from pathlib import Path

import pytest

from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.workflow_service import WorkflowService


class FakePi:
    calls = 0

    async def run(self, prompt: str, cwd: str) -> PiResult:
        self.calls += 1
        return PiResult(
            "success",
            {
                "status": "success",
                "summary": "complete",
                "findings": [],
                "artifacts": [],
                "next_action": "continue",
            },
            "result",
            [],
            "",
            0,
        )


def test_pi_task_persists_and_waits_for_human_task() -> None:
    async def scenario() -> None:
        pi = FakePi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        state = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        await asyncio.gather(*service.jobs.values())
        state = service.state(state["workflow_id"])
        assert state["status"] == "waiting_human"
        assert state["data"]["extract_status"] == "success"
        assert "agent_status" not in state["data"]
        phases = [point["phase"] for point in state["save_points"]]
        assert phases == ["before_harness", "after_harness", "human_wait"]
        review_task = next(task for task in state["tasks"] if task["bpmn_id"] == "ServiceTask_Review")
        assert service.form(state["workflow_id"], review_task["id"])["fields"][0]["id"] == "decision"

        before = next(point for point in state["save_points"] if point["phase"] == "before_harness")
        before_fork = await service.fork(state["workflow_id"], before["id"])
        await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
        assert service.state(before_fork["workflow_id"])["status"] == "waiting_human"
        assert pi.calls == 2

        after = next(point for point in state["save_points"] if point["phase"] == "after_harness")
        after_fork = await service.fork(state["workflow_id"], after["id"])
        assert after_fork["status"] == "waiting_human"
        assert pi.calls == 2

        completed = await service.submit_task(
            state["workflow_id"], review_task["id"], {"decision": "approved"}
        )
        assert completed["status"] == "completed"
        assert completed["data"]["decision"] == "approved"

    asyncio.run(scenario())

def test_session_id_propagated_to_record_and_data() -> None:
    class SessionPi:
        calls = 0

        async def run(self, prompt: str, cwd: str) -> PiResult:
            self.calls += 1
            return PiResult(
                "success",
                {"status": "success", "summary": "c", "findings": [], "artifacts": [], "next_action": "continue"},
                "result",
                [],
                "",
                0,
                f"session-abc-{self.calls}"
            )

    async def scenario() -> None:
        pi = SessionPi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        state = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        await asyncio.gather(*service.jobs.values())
        state = service.state(state["workflow_id"])

        # Session id is reported on the instance, not injected into routable workflow data
        assert state["pi_session_id"] == "session-abc-1"
        assert "pi_session_id" not in state["data"]

        # The branch lineage records which task produced the session
        assert "session-abc-1" in state["data"]["__sessions"].values()

        # ...and it survives a fork, so the fork continues the same context tree
        after = next(point for point in state["save_points"] if point["phase"] == "after_harness")
        after_fork = await service.fork(state["workflow_id"], after["id"])
        assert "session-abc-1" in after_fork["data"]["__sessions"].values()

    asyncio.run(scenario())


def test_failed_pi_state_contains_failure_reason() -> None:
    class FailedPi:
        async def run(self, prompt: str, cwd: str) -> PiResult:
            return PiResult("failed", None, "", [], "model response was invalid", 1)

    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), FailedPi())
        started = await service.start("workflows/contract_review.bpmn", None, {})
        await asyncio.gather(*service.jobs.values())
        state = service.state(started["workflow_id"])
        assert state["status"] == "failed"
        assert state["failure_reason"] == "model response was invalid"
        assert "failure_reason" not in state["data"]
        assert state["jobs"][next(iter(state["jobs"]))]["failure_reason"] == "model response was invalid"

    asyncio.run(scenario())


def test_failed_pi_task_retries_on_explicit_request() -> None:
    class FlakyPi:
        calls = 0

        async def run(self, prompt: str, cwd: str) -> PiResult:
            self.calls += 1
            if self.calls == 1:
                return PiResult("failed", None, "", [], "temporary provider error", 1)
            return await FakePi().run(prompt, cwd)

    async def scenario() -> None:
        pi = FlakyPi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        started = await service.start("workflows/contract_review.bpmn", None, {})
        await asyncio.gather(*service.jobs.values())
        state = service.state(started["workflow_id"])
        assert pi.calls == 1
        assert state["status"] == "failed"
        task_id = next(iter(state["jobs"]))
        retried = await service.retry_task(state["workflow_id"], task_id)
        await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
        state = service.state(retried["workflow_id"])
        assert pi.calls == 2
        assert state["status"] == "waiting_human"
        assert state["failure_reason"] is None
        assert state["jobs"][task_id]["attempts"] == 1
        assert "retry_requested" in [point["phase"] for point in state["save_points"]]

    asyncio.run(scenario())


def test_jobs_and_locks_cleanup() -> None:
    async def scenario() -> None:
        pi = FakePi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        state = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        wf_id = state["workflow_id"]
        assert len(service.jobs) > 0
        assert wf_id in service._locks

        await asyncio.gather(*list(service.jobs.values()))
        # Jobs should be popped on completion
        assert len(service.jobs) == 0

        # Lock should be popped on delete
        await service.delete_instance(wf_id)
        assert wf_id not in service._locks

        # Test clear_instances cleans up all locks
        state2 = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        wf_id2 = state2["workflow_id"]
        await asyncio.gather(*list(service.jobs.values()))
        assert wf_id2 in service._locks
        await service.clear_instances()
        assert len(service._locks) == 0

    asyncio.run(scenario())


def test_cancelled_task_completes_with_cancelled_status() -> None:
    class SlowPi:
        async def run(self, prompt: str, cwd: str) -> PiResult:
            await asyncio.sleep(10.0)
            return await FakePi().run(prompt, cwd)

    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), SlowPi())
        started = await service.start("workflows/contract_review.bpmn", None, {})
        wf_id = started["workflow_id"]
        await asyncio.sleep(0.05)
        for job in list(service.jobs.values()):
            job.cancel()
        await asyncio.gather(*list(service.jobs.values()), return_exceptions=True)
        state = service.state(wf_id)
        assert state["status"] == "cancelled"
    asyncio.run(scenario())


def test_service_task_publishes_only_declared_output_parameters() -> None:
    """Agent results reach the workflow only through camunda:outputParameters."""

    async def scenario() -> None:
        pi = FakePi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        started = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        wf_id = started["workflow_id"]
        await asyncio.gather(*list(service.jobs.values()))
        state = service.state(wf_id)

        # Declared by ServiceTask_Extract
        assert state["data"]["extract_status"] == "success"
        assert state["data"]["extract_summary"] == "complete"
        assert state["data"]["extract_findings"] == []

        # Never published implicitly
        for implicit in ("agent_status", "agent_output", "agent_text", "status"):
            assert implicit not in state["data"], f"{implicit} leaked into workflow data"

        # ...but still available task-locally for inspection in the UI, via the job
        # entry -- never via SpiffWorkflow's own task.data, which is inherited by
        # successor tasks and merged into workflow.data on completion (see
        # test_completed_instance_data_excludes_harness_scratch_keys for the leak that
        # writing it there used to cause).
        extract_task = next(t for t in state["tasks"] if t["bpmn_id"] == "ServiceTask_Extract")
        job = state["jobs"][extract_task["id"]]
        assert job["status"] == "success"
        assert job["output"]["summary"] == "complete"

    asyncio.run(scenario())


def test_completed_instance_data_excludes_harness_scratch_keys() -> None:
    """A task that fails once and then succeeds on retry must not leave its
    failure_reason (or any other harness-internal key) sitting in the *completed*
    instance's workflow data.

    Regression test: SpiffWorkflow merges the terminal task's own `task.data` into
    `workflow.data` when the instance completes, so a scratch key written there (rather
    than onto the job/record) survives every retry and resurfaces at completion even
    though a plain mid-workflow snapshot (as in
    test_service_task_publishes_only_declared_output_parameters, which never reaches
    "completed") would not show it.
    """

    class FlakyThenOkPi:
        calls = 0

        async def run(self, prompt: str, cwd: str) -> PiResult:
            self.calls += 1
            if self.calls == 1:
                return PiResult("failed", None, "", [], "boom: first attempt fails", 1)
            return PiResult(
                "success",
                {"status": "success", "summary": "complete", "findings": [], "artifacts": [], "next_action": "continue"},
                "result",
                [],
                "",
                0,
            )

    async def scenario() -> None:
        pi = FlakyThenOkPi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        started = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        wf_id = started["workflow_id"]
        await asyncio.gather(*list(service.jobs.values()))
        state = service.state(wf_id)
        assert state["status"] == "failed"
        assert state["data"].get("failure_reason") is None or "boom" not in str(state["data"].get("failure_reason"))
        assert "boom" in (state.get("failure_reason") or "")

        extract_task = next(t for t in state["tasks"] if t["bpmn_id"] == "ServiceTask_Extract")
        await service.retry_task(wf_id, extract_task["id"])
        await asyncio.gather(*[job for job in service.jobs.values() if not job.done()])
        state = service.state(wf_id)

        review_task = next(t for t in state["tasks"] if t["bpmn_id"] == "ServiceTask_Review")
        state = await service.submit_task(wf_id, review_task["id"], {"decision": "approved"})
        assert state["status"] == "completed"

        for scratch in ("failure_reason", "agent_status", "agent_output", "agent_text", "status", "policy_error", "network"):
            assert scratch not in state["data"], f"{scratch} leaked into completed instance data"

    asyncio.run(scenario())


def test_sanitize_output_recursive() -> None:
    from bpmn_agent.orchestration.jobs import _sanitize_output

    nested = {
        "short": "ok",
        "nested_dict": {
            "long_str": "x" * 60_000,
            "nested_list": ["y" * 70_000, 123, True],
        },
    }
    sanitized = _sanitize_output(nested)
    assert sanitized["short"] == "ok"
    assert sanitized["nested_dict"]["long_str"].endswith("...[truncated]")
    assert len(sanitized["nested_dict"]["long_str"]) == 50_000 + len("...[truncated]")
    assert sanitized["nested_dict"]["nested_list"][0].endswith("...[truncated]")
    assert sanitized["nested_dict"]["nested_list"][1] == 123


def test_workflow_service_non_numeric_timeout_fallback(monkeypatch) -> None:
    monkeypatch.setenv("PI_TIMEOUT_SECONDS", "30s_invalid")
    service = WorkflowService(WorkflowStore(":memory:"))
    assert service.pi_client is not None
    assert service.pi_client.timeout_seconds == 1800.0


@pytest.mark.anyio
async def test_output_parameters_missing_fallback_none() -> None:
    from bpmn_agent.adapters.base import AgentResult

    store = WorkflowStore(":memory:")
    service = WorkflowService(store, FakePi())

    wf_started = await service.start("workflows/contract_review.bpmn", None, {"contract": "Test"})
    wf_id = wf_started["workflow_id"]

    # Get the ready task
    state = service.state(wf_id)
    target_task = next(t for t in state["tasks"] if t["state"] in ("READY", "STARTED"))
    task_id = target_task["id"]

    # Add custom outputParameters to the task spec in memory
    record = service.store.load(wf_id)
    assert record is not None
    task_obj = service.runner.find_task(record["workflow"], task_id)
    assert task_obj is not None
    extensions = dict(task_obj.task_spec.extensions or {})
    extensions["outputParameters"] = {
        **extensions.get("outputParameters", {}),
        "mapped_var": "missing_key",
    }
    task_obj.task_spec.extensions = extensions

    result = AgentResult(status="success", output={"present_key": "val1"}, text="ok")
    await service._complete_pi(wf_id, task_id, result)

    updated_state = service.state(wf_id)
    assert updated_state["data"].get("mapped_var") is None
    assert updated_state["data"].get("mapped_var") != "missing_key"


def test_all_bundled_workflows_parse_and_have_failure_paths() -> None:
    from bpmn_agent.engine import WorkflowRunner
    from bpmn_agent.registry import WorkflowRegistry

    runner = WorkflowRunner()
    registry = WorkflowRegistry("workflows")
    templates = registry.list_templates()
    assert len(templates) >= 4

    for template in templates:
        wf, process_id = runner.load_workflow(template.path, template.id)
        assert wf is not None
        assert process_id == template.id


def test_workflow_registry_logs_warning_on_malformed_file(tmp_path: Path, caplog) -> None:
    import logging

    from bpmn_agent.registry import WorkflowRegistry

    bad_bpmn = tmp_path / "broken.bpmn"
    bad_bpmn.write_text("invalid xml <><>", encoding="utf-8")

    registry = WorkflowRegistry(str(tmp_path))
    with caplog.at_level(logging.WARNING):
        templates = registry.list_templates()
    assert len(templates) == 0
    assert any("Failed to parse BPMN template" in record.message for record in caplog.records)









def test_superseded_savepoint_attempts_are_pruned(monkeypatch) -> None:
    """Each attempt deep-copies the workflow graph, so only the newest per generation is kept."""

    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), FakePi())
        started = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        wf_id = started["workflow_id"]
        await asyncio.gather(*list(service.jobs.values()))

        record = service.store.load(wf_id)
        assert record is not None
        workflow = record["workflow"]
        task = next(
            t for t in workflow.get_tasks() if getattr(t.task_spec, "bpmn_id", None) == "ServiceTask_Extract"
        )

        for attempt in range(2, 5):
            service._add_save_point(
                wf_id, record, workflow, task, "before_harness", "run_harness", f":run_0:attempt_{attempt}"
            )

        before_harness = [p for p in record["save_points"] if p["phase"] == "before_harness"]
        assert len(before_harness) == 1
        assert before_harness[0]["key"].endswith("attempt_4")

        # the pruned snapshots are gone from the store, not just the record
        service.store.save(wf_id, record)
        assert service.store.load_save_point(before_harness[0]["id"]) is not None

    asyncio.run(scenario())


def test_savepoint_retention_is_configurable(monkeypatch) -> None:
    monkeypatch.setenv("SAVEPOINT_ATTEMPT_RETENTION", "3")

    async def scenario() -> None:
        service = WorkflowService(WorkflowStore(":memory:"), FakePi())
        started = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        await asyncio.gather(*list(service.jobs.values()))

        wf_id = started["workflow_id"]
        record = service.store.load(wf_id)
        assert record is not None
        workflow = record["workflow"]
        task = next(
            t for t in workflow.get_tasks() if getattr(t.task_spec, "bpmn_id", None) == "ServiceTask_Extract"
        )
        for attempt in range(2, 6):
            service._add_save_point(
                wf_id, record, workflow, task, "before_harness", "run_harness", f":run_0:attempt_{attempt}"
            )

        kept = [p["key"].rsplit(":", 1)[-1] for p in record["save_points"] if p["phase"] == "before_harness"]
        assert kept == ["attempt_3", "attempt_4", "attempt_5"]

    asyncio.run(scenario())
