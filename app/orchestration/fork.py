"""Branching a workflow from a past savepoint into a brand-new instance.

Its own file because "fork" is a first-class user-facing operation (savepoint fork /
design-variant exploration, AGENTS.md) distinct from creating a savepoint in the first
place (savepoints.py) or running one (jobs.py) -- an agent asking "how does fork work"
should find one place, not the middle of a 1500-line file.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import uuid
from typing import TYPE_CHECKING, Any

from app.ws import manager as ws_manager

if TYPE_CHECKING:
    from app.workflow_service import WorkflowService

logger = logging.getLogger("bpmn.workflow")


async def fork(
    service: WorkflowService,
    workflow_id: str,
    save_point_id: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    async with service._lock(workflow_id):
        source = service._record(workflow_id)
        if source.get("parent_workflow_id"):
            raise ValueError(
                f"Cannot fork child workflow '{workflow_id}' directly; fork root workflow '{source['parent_workflow_id']}' instead"
            )
        logger.info("Forking workflow from savepoint", extra={"workflow_id": workflow_id, "save_point_id": save_point_id})
        point = service.store.load_save_point(save_point_id)
        if point is None:
            point = next(
                (candidate for candidate in source.get("save_points", []) if candidate.get("id") == save_point_id),
                None,
            )
        if point is None or point.get("workflow") is None:
            raise KeyError(save_point_id)
        workflow = copy.deepcopy(point["workflow"])
        source_save_points = copy.deepcopy(source.get("save_points", []))
        source_bpmn_path = source["bpmn_path"]
        source_process_id = source["process_id"]
    if variables:
        workflow.data.update(variables)
    if point.get("resume_action") == "complete_harness":
        task = service.runner.find_task(workflow, point["task_id"])
        task.complete()
        workflow.do_engine_steps()
    fork_id = uuid.uuid4().hex
    record = service.runner.record(
        fork_id,
        workflow,
        source_bpmn_path,
        source_process_id,
        service._status(workflow),
        jobs={},
        save_points=source_save_points,
        events=[],
        forked_from=workflow_id,
        forked_from_save_point=save_point_id,
        # load_save_point() already hands back a standalone Blob copy, independent
        # of the savepoint's own stored blob -- no need to duplicate it again here.
        workspace_blob=point.get("workspace_blob"),
        parent_workflow_id=point.get("parent_workflow_id"),
    )
    await asyncio.to_thread(service.store.save, fork_id, record)
    service._sync_children(fork_id, record)
    service.events.emit(
        "fork_created",
        fork_id,
        data={"parent_workflow_id": workflow_id, "save_point_id": save_point_id},
    )
    await service._dispatch(fork_id)
    state = service.state(fork_id)
    await ws_manager.broadcast(fork_id, state)
    return state
