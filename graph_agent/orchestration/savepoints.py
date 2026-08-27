"""Savepoint lifecycle: recording, retrieving, and purging durable checkpoints.

Every fork target and every audit-trail entry is a savepoint. `WorkflowService` calls
into this module from `_dispatch`/`_run_pi`/`_complete_pi` (jobs.py), `retry_task`, and
the API-facing `save_point_detail`/`purge_save_points` -- split out here because the
retention/pruning invariants (see `purge_save_points`) are dense enough to want one
place, not because savepoints are otherwise decoupled from the rest of the engine.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import re
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from graph_agent.workspace_strategy import BlobStrategy, select_strategy

if TYPE_CHECKING:
    from graph_agent.workflow_service import WorkflowService

logger = logging.getLogger("bpmn.workflow")


def _attempt_retention() -> int:
    """How many savepoints to keep per (task, phase, generation).

    Each savepoint deep-copies the whole workflow graph and duplicates the workspace
    blob, so superseded attempts of the same turn are the dominant source of storage
    growth. The newest attempt of every generation is always kept, so every meaningful
    fork target survives.
    """
    try:
        return max(1, int(os.getenv("SAVEPOINT_ATTEMPT_RETENTION", "1")))
    except (TypeError, ValueError):
        return 1


def _generation_of(key: str) -> str:
    match = re.search(r":run_(\d+)", key or "")
    return match.group(1) if match else ""


async def add_save_point(
    service: WorkflowService,
    workflow_id: str,
    record: dict[str, Any],
    workflow: Any,
    task: Any,
    phase: str,
    resume_action: str,
    key_suffix: str = "",
) -> None:
    save_points = record.setdefault("save_points", [])
    task_id_str = str(task.id) if task is not None else ""
    task_name_str = getattr(task.task_spec, "bpmn_name", task.task_spec.name) if task is not None else phase
    key = f"{task_id_str}:{phase}{key_suffix}" if task_id_str else f"{phase}:{uuid.uuid4().hex[:8]}{key_suffix}"
    if any(point.get("key") == key for point in save_points):
        return

    # Which strategy this task's turns run under decides what a durable checkpoint even
    # means: BlobStrategy's snapshot is a duplicated ZODB Blob (workspace_blob below,
    # unchanged from before this module knew about strategies at all); WorktreeStrategy's
    # is a git commit SHA (workspace_ref); InPlaceStrategy has none at all
    # (supports_snapshot=False) -- graph state (data/tasks/workflow below) is still
    # captured regardless, only the file-level checkpoint is missing.
    config = service.runner.pi_config(task) if task is not None else {}
    strategy = select_strategy(service.workspace, service.store, config, workflow.data)
    workspace_blob = None
    workspace_ref = None
    if strategy.supports_snapshot:
        snapshot = await strategy.snapshot(workflow_id, key)
        if isinstance(strategy, BlobStrategy):
            workspace_blob = snapshot
        else:
            workspace_ref = snapshot

    save_points.append(
        {
            "id": uuid.uuid4().hex,
            "key": key,
            "phase": phase,
            "resume_action": resume_action,
            "task_id": task_id_str,
            "task_name": task_name_str,
            "status": record.get("status", "running"),
            "created_at": datetime.now(UTC).isoformat(),
            "data": dict(workflow.data),
            "tasks": service.runner.task_snapshot(workflow),
            "workflow": copy.deepcopy(workflow),
            "parent_workflow_id": record.get("parent_workflow_id"),
            "workspace_blob": workspace_blob,
            "workspace_ref": workspace_ref,
            "supports_snapshot": strategy.supports_snapshot,
        }
    )
    if task_id_str:
        _prune_save_points(service, record, task_id_str, phase)


def _prune_save_points(service: WorkflowService, record: dict[str, Any], task_id: str, phase: str) -> None:
    """Drop superseded attempts of the same turn from this record."""
    retention = _attempt_retention()
    points = record.get("save_points", [])
    by_generation: dict[str, list[dict[str, Any]]] = {}
    for point in points:
        if point.get("task_id") != task_id or point.get("phase") != phase:
            continue
        by_generation.setdefault(_generation_of(point.get("key", "")), []).append(point)

    superseded = {
        point["id"]
        for group in by_generation.values()
        if len(group) > retention
        for point in group[:-retention]
        if point.get("id")
    }
    if not superseded:
        return

    record["save_points"] = [p for p in points if p.get("id") not in superseded]
    for save_point_id in superseded:
        try:
            service.store.delete_save_point(save_point_id)
        except Exception as exc:
            logger.warning("Failed to delete superseded savepoint %s: %s", save_point_id, exc)
    logger.info("Pruned %d superseded savepoint(s) for task %s phase %s", len(superseded), task_id, phase)


def _savepoint_to_detail(point: dict[str, Any], workflow_id: str) -> dict[str, Any]:
    return {
        "id": point["id"],
        "workflow_id": workflow_id,
        "key": point["key"],
        "phase": point["phase"],
        "resume_action": point["resume_action"],
        "task_id": point["task_id"],
        "task_name": point["task_name"],
        "status": point["status"],
        "created_at": point["created_at"],
        "data": point["data"],
        "tasks": point["tasks"],
    }


def save_point_detail(service: WorkflowService, workflow_id: str, save_point_id: str) -> dict[str, Any]:
    point = service.store.load_save_point(save_point_id)
    if point is not None:
        return _savepoint_to_detail(point, workflow_id)
    record = service._record(workflow_id)
    for point in record.get("save_points", []):
        if point.get("id") == save_point_id:
            return _savepoint_to_detail(point, workflow_id)
    raise KeyError(save_point_id)


async def purge_save_points(
    service: WorkflowService,
    workflow_id: str,
    before: str | None = None,
    before_task_id: str | None = None,
) -> dict[str, int]:
    """Delete every savepoint older than an anchor, releasing its workspace blob.

    Deliberately manual-only, per plans/concepts.md "Savepoint retention is a manual
    purge" -- an age/count policy can't judge which past states are still worth forking
    from, only the user can. Exactly one anchor is required: `before` (an ISO-8601
    timestamp) or `before_task_id` (an element).

    **Both anchors satisfy one invariant: a task's savepoints are never split.** An agent
    task records both a `before_harness` and an `after_harness` savepoint, so a cut-off
    landing between them would delete the task's entry state while keeping its exit state
    -- and via the UI, which sends only a task id and lets the operator click either row,
    it would delete the very savepoint they clicked Purge on. Both anchors therefore
    resolve to the *oldest* savepoint of whichever task owns the boundary, so that task
    survives whole. A task entirely older than the cut-off is still removed whole.
    """
    if bool(before) == bool(before_task_id):
        raise ValueError("purge requires exactly one of 'before' or 'before_task_id'")

    workflow_id = service._get_root_workflow_id(workflow_id)
    async with service._lock(workflow_id):
        record = service._record(workflow_id)
        points = record.get("save_points", [])

        if before_task_id is not None:
            boundary_task_id: str | None = before_task_id
            if not any(p.get("task_id") == before_task_id for p in points):
                raise ValueError(f"no savepoints found for task {before_task_id!r}")
        else:
            # Snap the timestamp to the task that straddles it. With nothing at or after
            # the cut-off no task straddles it, so the raw timestamp is already safe.
            at_or_after = sorted(
                (p for p in points if p.get("created_at") >= before),
                key=lambda p: p["created_at"],
            )
            boundary_task_id = at_or_after[0].get("task_id") if at_or_after else None

        if boundary_task_id is None:
            cutoff = before
        else:
            cutoff = min(p["created_at"] for p in points if p.get("task_id") == boundary_task_id)

        purge_ids = {p["id"] for p in points if p.get("created_at") < cutoff and p.get("id")}
        if purge_ids:
            record["save_points"] = [p for p in points if p.get("id") not in purge_ids]
            for save_point_id in purge_ids:
                try:
                    service.store.delete_save_point(save_point_id)
                except Exception as exc:
                    logger.warning("Failed to delete purged savepoint %s: %s", save_point_id, exc)
            await asyncio.to_thread(service.store.save, workflow_id, record)

        remaining = len(record.get("save_points", []))
        logger.info(
            "Purged savepoints",
            extra={"workflow_id": workflow_id, "purged": len(purge_ids), "remaining": remaining},
        )
        return {"purged": len(purge_ids), "remaining": remaining}
