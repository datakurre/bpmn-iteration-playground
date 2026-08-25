from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from bpmn_agent.adapters.base import AgentResult
from bpmn_agent.adapters.mock_adapter import MockAdapter
from bpmn_agent.workflow_service import WORKSPACE_CONFLICT_MESSAGE, WorkflowService
from bpmn_agent.workspace import cleanup_workspace, unpack_workspace


class ConfiguredFileWritingAdapter(MockAdapter):
    """Writes to the file named by the task's `output_file` camunda:property.

    Optionally waits on a barrier before repacking, so two concurrent turns can be made to
    genuinely overlap instead of relying on scheduling luck.
    """

    def __init__(self, barrier: asyncio.Barrier | None = None) -> None:
        super().__init__()
        self.barrier = barrier

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
        Path(cwd, config.get("output_file", "output.txt")).write_text("written by the agent")
        if self.barrier is not None:
            await self.barrier.wait()
        return await super().run(prompt, config, cwd, on_event)


async def _wait_for_agent_turns(service: WorkflowService) -> None:
    async def _wait() -> None:
        while any(not job.done() for job in list(service.jobs.values())):
            pending = [j for j in list(service.jobs.values()) if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_wait(), timeout=5.0)


async def _archive_names(blob_or_bytes: Any) -> set[str]:
    workdir = await unpack_workspace(blob_or_bytes, prefix="bpmn-concurrency-")
    try:
        return {p.name for p in Path(workdir).rglob("*") if p.is_file()}
    finally:
        cleanup_workspace(workdir)


def _task_id(record: dict[str, Any], bpmn_id: str) -> str:
    workflow = record["workflow"]
    task = next(t for t in workflow.get_tasks() if getattr(t.task_spec, "bpmn_id", None) == bpmn_id)
    return str(task.id)


@pytest.mark.anyio
async def test_concurrent_turns_do_not_silently_lose_files(service: WorkflowService) -> None:
    barrier = asyncio.Barrier(2)
    service.registry.register(ConfiguredFileWritingAdapter(barrier))

    results: list[tuple[str, AgentResult]] = []
    original_complete_pi = service._complete_pi

    async def _capture(
        workflow_id: str, task_id: str, result: Any, workspace_metadata: Any = None, prompt: str | None = None
    ) -> None:
        results.append((task_id, result))
        return await original_complete_pi(
            workflow_id, task_id, result, workspace_metadata=workspace_metadata, prompt=prompt
        )

    service._complete_pi = _capture  # type: ignore[method-assign]

    started = await service.start("tests/fixtures/parallel_agents.bpmn", "parallel_agents", {})
    wf_id = started["workflow_id"]

    record = service.store.load(wf_id)
    assert record is not None
    expected_filename = {
        _task_id(record, "Task_A"): "file_a.txt",
        _task_id(record, "Task_B"): "file_b.txt",
    }

    await _wait_for_agent_turns(service)

    assert len(results) == 2, "both concurrent turns must complete (one may fail, neither may hang)"
    final_names = await _archive_names(service.store.get_workspace(wf_id))

    for task_id, result in results:
        if result.status == "success":
            assert expected_filename[task_id] in final_names, (
                f"turn for {task_id} reported success but its file was discarded"
            )

    statuses = sorted(result.status for _, result in results)
    assert statuses == ["failed", "success"], "exactly one concurrent turn should win the race"
    conflict_result = next(result for _, result in results if result.status == "failed")
    assert conflict_result.stderr == WORKSPACE_CONFLICT_MESSAGE


@pytest.mark.anyio
async def test_sequential_turns_still_accumulate_files(service: WorkflowService) -> None:
    service.registry.register(ConfiguredFileWritingAdapter())

    started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
    wf_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    record = service.store.load(wf_id)
    assert record is not None
    assert record["status"] == "completed"
    jobs = record["jobs"]
    assert all(job.get("status") == "success" for job in jobs.values()), jobs

    final_names = await _archive_names(service.store.get_workspace(wf_id))
    assert "file_1.txt" in final_names
    assert "file_2.txt" in final_names


@pytest.mark.anyio
async def test_conflicted_turn_can_be_retried(service: WorkflowService) -> None:
    barrier = asyncio.Barrier(2)
    service.registry.register(ConfiguredFileWritingAdapter(barrier))

    started = await service.start("tests/fixtures/parallel_agents.bpmn", "parallel_agents", {})
    wf_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    record = service.store.load(wf_id)
    assert record is not None
    failed_task_id = next(
        task_id for task_id, job in record["jobs"].items() if job.get("status") == "failed"
    )
    assert record["jobs"][failed_task_id]["conflict"] is True

    # WorkspaceConflictError must not be retried automatically: the losing turn stays failed
    # until the caller explicitly retries it (todo 04 acceptance criteria).
    assert record["jobs"][failed_task_id]["status"] == "failed"

    # The barrier only pairs up the original two concurrent calls; retrying alone must not
    # block waiting for a second party that will never arrive.
    service.registry.register(ConfiguredFileWritingAdapter())

    retried = await service.retry_task(wf_id, failed_task_id)
    assert retried["jobs"][failed_task_id]["status"] in ("running", "waiting_pi", "retry_requested")

    await _wait_for_agent_turns(service)

    final_record = service.store.load(wf_id)
    assert final_record is not None
    assert final_record["jobs"][failed_task_id]["status"] == "success"
    assert final_record["status"] == "completed"

    final_names = await _archive_names(service.store.get_workspace(wf_id))
    assert "file_a.txt" in final_names
    assert "file_b.txt" in final_names
