from __future__ import annotations

from typing import Any


def sync_children(service: Any, root_workflow_id: str) -> None:
    """Sync CallActivity child workflows of `root_workflow_id` into the store.

    Thin wrapper around `WorkflowService._sync_children` so there is a single
    implementation of the parent/child walk.
    """
    root_record = service.store.load(root_workflow_id)
    if not root_record:
        return
    service._sync_children(root_workflow_id, root_record)
