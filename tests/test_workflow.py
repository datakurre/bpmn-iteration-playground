import asyncio
from pathlib import Path
import pytest

from app.persistence import WorkflowStore
from app.pi_rpc import PiResult
from app.workflow_service import WorkflowService


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
        assert state["data"]["agent_status"] == "success"
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
        assert state["data"]["failure_reason"] == "model response was invalid"
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


def test_agent_status_and_status_mapping() -> None:
    async def scenario() -> None:
        pi = FakePi()
        service = WorkflowService(WorkflowStore(":memory:"), pi)
        started = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
        wf_id = started["workflow_id"]
        await asyncio.gather(*list(service.jobs.values()))
        state = service.state(wf_id)
        assert state["data"]["agent_status"] == "success"
    asyncio.run(scenario())


def test_sanitize_output_recursive() -> None:
    from app.workflow_service import _sanitize_output

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
    from app.adapters.base import AgentResult

    store = WorkflowStore(":memory:")
    service = WorkflowService(store)

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
    task_obj.task_spec.extensions = {"outputParameters": {"mapped_var": "missing_key"}}

    result = AgentResult(status="success", output={"present_key": "val1"}, text="ok")
    await service._complete_pi(wf_id, task_id, result)

    updated_state = service.state(wf_id)
    assert updated_state["data"].get("mapped_var") is None
    assert updated_state["data"].get("mapped_var") != "missing_key"


def test_all_bundled_workflows_parse_and_have_failure_paths() -> None:
    from pathlib import Path
    from app.engine import WorkflowRunner
    from app.registry import WorkflowRegistry

    runner = WorkflowRunner()
    registry = WorkflowRegistry("workflows")
    templates = registry.list_templates()
    assert len(templates) >= 7

    for template in templates:
        wf, process_id = runner.load_workflow(template.path, template.id)
        assert wf is not None
        assert process_id == template.id


def test_workflow_registry_logs_warning_on_malformed_file(tmp_path: Path, caplog) -> None:
    import logging
    from app.registry import WorkflowRegistry

    bad_bpmn = tmp_path / "broken.bpmn"
    bad_bpmn.write_text("invalid xml <><>", encoding="utf-8")

    registry = WorkflowRegistry(str(tmp_path))
    with caplog.at_level(logging.WARNING):
        templates = registry.list_templates()
    assert len(templates) == 0
    assert any("Failed to parse BPMN template" in record.message for record in caplog.records)







