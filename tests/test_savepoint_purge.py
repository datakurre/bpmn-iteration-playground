from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from graph_agent.workflow_service import WorkflowService


async def _start_and_wait(service: WorkflowService) -> dict[str, Any]:
    started = await service.start("graph_agent/data/workflows/plan_and_execute.bpmn", None, {"goal": "text"})
    await asyncio.gather(*list(service.jobs.values()))
    return started


def _sorted_points(service: WorkflowService, workflow_id: str) -> list[dict[str, Any]]:
    record = service.store.load(workflow_id)
    assert record is not None
    return sorted(record["save_points"], key=lambda p: p["created_at"])


@pytest.mark.anyio
async def test_purge_savepoints_before_timestamp(service: WorkflowService) -> None:
    started = await _start_and_wait(service)
    wf_id = started["workflow_id"]

    points = _sorted_points(service, wf_id)
    assert len(points) >= 3
    cutoff = points[2]["created_at"]

    result = await service.purge_save_points(wf_id, before=cutoff)

    remaining = service.store.load(wf_id)["save_points"]  # type: ignore[index]
    assert all(p["created_at"] >= cutoff for p in remaining)
    assert result["purged"] == 2
    assert result["remaining"] == len(remaining)
    for p in points[:2]:
        assert service.store.load_save_point(p["id"]) is None


@pytest.mark.anyio
async def test_purge_savepoints_before_task(service: WorkflowService) -> None:
    started = await _start_and_wait(service)
    wf_id = started["workflow_id"]

    points = _sorted_points(service, wf_id)
    newest_task_id = points[-1]["task_id"]

    result = await service.purge_save_points(wf_id, before_task_id=newest_task_id)

    remaining = service.store.load(wf_id)["save_points"]  # type: ignore[index]
    remaining_ids = {p["id"] for p in remaining}
    # the anchor task's own (newest) savepoint survives
    assert points[-1]["id"] in remaining_ids
    # every savepoint strictly older than it is gone
    for p in points[:-1]:
        assert p["id"] not in remaining_ids
        assert service.store.load_save_point(p["id"]) is None
    assert result["purged"] == len(points) - 1


@pytest.mark.anyio
async def test_purge_savepoints_before_unknown_task_raises(service: WorkflowService) -> None:
    started = await _start_and_wait(service)
    wf_id = started["workflow_id"]

    with pytest.raises(ValueError):
        await service.purge_save_points(wf_id, before_task_id="does-not-exist")


def test_purge_endpoint(client: TestClient, service: WorkflowService) -> None:
    wf_id = asyncio.run(_start_and_wait(service))["workflow_id"]
    points = _sorted_points(service, wf_id)
    task_id = points[-1]["task_id"]

    resp = client.request("DELETE", f"/instance/{wf_id}/savepoints", json={"before_task_id": task_id})
    assert resp.status_code == 200
    assert resp.json()["purged"] >= 1


def test_purge_endpoint_unknown_instance(client: TestClient) -> None:
    resp = client.request("DELETE", "/instance/nope/savepoints", json={"before": "2026-01-01T00:00:00+00:00"})
    assert resp.status_code == 404


def test_purge_requires_an_anchor(client: TestClient, service: WorkflowService) -> None:
    wf_id = asyncio.run(_start_and_wait(service))["workflow_id"]
    resp = client.request("DELETE", f"/instance/{wf_id}/savepoints", json={})
    assert resp.status_code == 400


def test_purge_rejects_both_anchors(client: TestClient, service: WorkflowService) -> None:
    wf_id = asyncio.run(_start_and_wait(service))["workflow_id"]
    points = _sorted_points(service, wf_id)
    resp = client.request(
        "DELETE",
        f"/instance/{wf_id}/savepoints",
        json={"before": points[-1]["created_at"], "before_task_id": points[-1]["task_id"]},
    )
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_purge_does_not_affect_existing_forks(service: WorkflowService) -> None:
    started = await _start_and_wait(service)
    wf_id = started["workflow_id"]

    points = _sorted_points(service, wf_id)
    source_sp_id = points[1]["id"]  # after_harness: has a real, forkable workflow snapshot

    forked = await service.fork(wf_id, source_sp_id)
    fork_id = forked["workflow_id"]
    fork_workspace_before = service.store.get_workspace(fork_id)

    cutoff = points[2]["created_at"]  # strictly after the forked-from savepoint
    result = await service.purge_save_points(wf_id, before=cutoff)
    assert result["purged"] >= 1
    assert service.store.load_save_point(source_sp_id) is None

    fork_record = service.store.load(fork_id)
    assert fork_record is not None
    assert service.store.get_workspace(fork_id) == fork_workspace_before


@pytest.mark.anyio
async def test_purge_before_task_keeps_all_of_the_anchor_tasks_savepoints(
    service: WorkflowService,
) -> None:
    """Anchoring on a task keeps *every* savepoint of that task, not just its newest.

    An agent task records two savepoints (`before_harness`, `after_harness`). Resolving the
    anchor to the task's newest point silently deleted its `before_harness` sibling -- which
    is the very savepoint the operator clicked Purge on in the UI, and which the confirmation
    dialog had promised to keep. See plans/concepts.md "Savepoint retention is a manual purge".
    """
    started = await _start_and_wait(service)
    wf_id = started["workflow_id"]

    points = _sorted_points(service, wf_id)
    counts: dict[str, list[dict[str, Any]]] = {}
    for p in points:
        counts.setdefault(p["task_id"], []).append(p)
    anchor_task_id, anchor_points = next((tid, pts) for tid, pts in counts.items() if len(pts) >= 2)
    older = [p for p in points if p["created_at"] < min(a["created_at"] for a in anchor_points)]

    result = await service.purge_save_points(wf_id, before_task_id=anchor_task_id)

    remaining_ids = {p["id"] for p in service.store.load(wf_id)["save_points"]}  # type: ignore[index]
    for p in anchor_points:
        assert p["id"] in remaining_ids, "the anchor task's own savepoints must all survive"
    for p in older:
        assert p["id"] not in remaining_ids
    assert result["purged"] == len(older)


@pytest.mark.anyio
async def test_purge_before_timestamp_never_splits_a_task(service: WorkflowService) -> None:
    """A `before` timestamp landing mid-task keeps that task whole, like `before_task_id` does.

    Both anchors on this endpoint must satisfy one invariant: a task's savepoints are never
    split. Without snapping, passing the timestamp of an agent task's `after_harness` deleted
    its `before_harness` sibling -- the same defect todo 10 fixed for the element anchor,
    surviving on the timestamp path.
    """
    started = await _start_and_wait(service)
    wf_id = started["workflow_id"]

    points = _sorted_points(service, wf_id)
    by_task: dict[str, list[dict[str, Any]]] = {}
    for p in points:
        by_task.setdefault(p["task_id"], []).append(p)
    anchor_points = next(pts for pts in by_task.values() if len(pts) >= 2)

    # A cut-off strictly inside the anchor task: after its first savepoint, at its last.
    result = await service.purge_save_points(wf_id, before=anchor_points[-1]["created_at"])

    remaining_ids = {p["id"] for p in service.store.load(wf_id)["save_points"]}  # type: ignore[index]
    for p in anchor_points:
        assert p["id"] in remaining_ids, "a mid-task cut-off must not split the task"
    older = [p for p in points if p["created_at"] < anchor_points[0]["created_at"]]
    assert result["purged"] == len(older)
