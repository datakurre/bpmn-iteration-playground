from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from bpmn_agent.adapters.base import AgentResult
from bpmn_agent.adapters.mock_adapter import MockAdapter
from bpmn_agent.workflow_service import WorkflowService
from bpmn_agent.workspace import cleanup_workspace, unpack_workspace


class FileWritingAdapter(MockAdapter):
    """Writes a real file to the workspace, unlike MockAdapter/FakePi which don't touch disk."""

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
        Path(cwd, "agent_output.txt").write_text("written by the agent")
        return await super().run(prompt, config, cwd, on_event)


async def _wait_for_agent_turn(service: WorkflowService) -> None:
    async def _wait() -> None:
        while any(not job.done() for job in list(service.jobs.values())):
            pending = [j for j in list(service.jobs.values()) if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_wait(), timeout=5.0)


async def _archive_names(blob_or_bytes: Any) -> set[str]:
    workdir = await unpack_workspace(blob_or_bytes, prefix="bpmn-archtest-")
    try:
        return {p.name for p in Path(workdir).rglob("*") if p.is_file()}
    finally:
        cleanup_workspace(workdir)


def _save_point_after_harness(record: dict[str, Any]) -> dict[str, Any]:
    return next(sp for sp in record["save_points"] if sp["phase"] == "after_harness")


def _save_point_before_first_harness(record: dict[str, Any]) -> dict[str, Any]:
    return next(sp for sp in record["save_points"] if sp["phase"] == "before_harness")


@pytest.mark.anyio
async def test_fork_preserves_agent_files(service: WorkflowService) -> None:
    service.registry.register(FileWritingAdapter())
    started = await service.start("bpmn_agent/data/workflows/contract_review.bpmn", None, {"contract": "x"})
    wf_id = started["workflow_id"]
    await _wait_for_agent_turn(service)

    # the live instance has the file
    live_names = await _archive_names(service.store.get_workspace(wf_id))
    assert "agent_output.txt" in live_names

    record = service.store.load(wf_id)
    assert record is not None
    sp = _save_point_after_harness(record)
    forked = await service.fork(wf_id, sp["id"])

    fork_names = await _archive_names(service.store.get_workspace(forked["workflow_id"]))
    assert "agent_output.txt" in fork_names, "fork lost the agent's files"


@pytest.mark.anyio
async def test_fork_workspace_is_independent_of_parent(service: WorkflowService) -> None:
    service.registry.register(FileWritingAdapter())
    started = await service.start("bpmn_agent/data/workflows/contract_review.bpmn", None, {"contract": "x"})
    wf_id = started["workflow_id"]
    await _wait_for_agent_turn(service)

    record = service.store.load(wf_id)
    assert record is not None
    sp = _save_point_after_harness(record)

    fork_a = await service.fork(wf_id, sp["id"])
    fork_b = await service.fork(wf_id, sp["id"])

    # mutate fork_a's workspace only
    service.store.set_workspace(fork_a["workflow_id"], b"mutated-bytes")

    assert service.store.get_workspace(fork_a["workflow_id"]) == b"mutated-bytes"
    assert service.store.get_workspace(fork_b["workflow_id"]) != b"mutated-bytes"

    parent_names = await _archive_names(service.store.get_workspace(wf_id))
    assert "agent_output.txt" in parent_names, "mutating a fork must not affect the parent"

    fork_b_names = await _archive_names(service.store.get_workspace(fork_b["workflow_id"]))
    assert "agent_output.txt" in fork_b_names, "mutating one fork must not affect a sibling fork"


@pytest.mark.anyio
async def test_fork_from_first_savepoint_starts_clean(service: WorkflowService) -> None:
    service.registry.register(FileWritingAdapter())
    started = await service.start("bpmn_agent/data/workflows/contract_review.bpmn", None, {"contract": "x"})
    wf_id = started["workflow_id"]

    record = service.store.load(wf_id)
    assert record is not None
    sp = _save_point_before_first_harness(record)

    await _wait_for_agent_turn(service)

    forked = await service.fork(wf_id, sp["id"])

    fork_names = await _archive_names(service.store.get_workspace(forked["workflow_id"]))
    assert "agent_output.txt" not in fork_names
