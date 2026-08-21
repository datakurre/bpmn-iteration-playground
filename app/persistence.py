from __future__ import annotations

import os
import tempfile
import time
import uuid
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Callable, TypeVar

from BTrees.OOBTree import OOBTree
from persistent import Persistent
from persistent.list import PersistentList
from persistent.mapping import PersistentMapping
from ZODB import DB
from ZODB.blob import Blob, BlobStorage
from ZODB.FileStorage import FileStorage
from ZODB.MappingStorage import MappingStorage
from ZODB.POSException import ConflictError

from app.migrations import migrate_workflow_object

F = TypeVar("F", bound=Callable[..., Any])


def _retry_on_conflict(max_retries: int = 5) -> Callable[[F], F]:
    def decorator(fn: F) -> F:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            for attempt in range(max_retries):
                try:
                    return fn(*args, **kwargs)
                except ConflictError:
                    if attempt == max_retries - 1:
                        raise
                    time.sleep(0.02 * (2 ** attempt))
        return wrapper  # type: ignore[return-value]
    return decorator


def _create_storage(path: str) -> tuple[Any, str | None]:
    """Create ZODB storage, supporting in-memory, FileStorage, or remote ZEO."""
    if path == ":memory:":
        blob_dir = tempfile.mkdtemp(prefix="bpmn-blobs-")
        return BlobStorage(blob_dir, MappingStorage()), blob_dir
    zeo_address = os.getenv("ZEO_ADDRESS")
    if zeo_address:
        from ZEO import ClientStorage

        host, port = zeo_address.rsplit(":", 1)
        for attempt in range(5):
            try:
                return ClientStorage.ClientStorage((host, int(port)), blob_dir="data/blobs"), None
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(0.5)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    blob_dir = str(Path(path).parent / "blobs")
    Path(blob_dir).mkdir(parents=True, exist_ok=True)
    return BlobStorage(blob_dir, FileStorage(path)), None


class WorkflowMetadata(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """Lightweight metadata for fast listing and indexing."""

    def __init__(
        self,
        workflow_id: str,
        process_id: str,
        bpmn_path: str,
        status: str,
        task_count: int = 0,
        save_point_count: int = 0,
        created_at: str | None = None,
        updated_at: str | None = None,
        data: dict[str, Any] | None = None,
        failure_reason: str | None = None,
        parent_workflow_id: str | None = None,
        workspace_metadata: dict[str, Any] | None = None,
    ) -> None:
        self.workflow_id = workflow_id
        self.process_id = process_id
        self.bpmn_path = bpmn_path
        self.status = status
        self.task_count = task_count
        self.save_point_count = save_point_count
        self.created_at = created_at
        self.updated_at = updated_at
        self.data = dict(data or {})
        self.failure_reason = failure_reason
        self.parent_workflow_id = parent_workflow_id
        self.workspace_metadata = dict(workspace_metadata or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflow_id": self.workflow_id,
            "parent_workflow_id": getattr(self, "parent_workflow_id", None),
            "process_id": self.process_id,
            "bpmn_path": self.bpmn_path,
            "status": self.status,
            "task_count": self.task_count,
            "save_point_count": self.save_point_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "data": dict(self.data),
            "failure_reason": self.failure_reason,
            "workspace_metadata": dict(getattr(self, "workspace_metadata", {})),
        }


class SavePointSnapshot(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """Independent persistent snapshot holding a deepcopied SpiffWorkflow object graph."""

    def __init__(
        self,
        id: str,
        workflow_id: str,
        key: str,
        phase: str,
        resume_action: str,
        task_id: str,
        task_name: str,
        status: str,
        created_at: str,
        data: dict[str, Any],
        tasks: list[dict[str, Any]],
        workflow: Any,
        parent_workflow_id: str | None = None,
        workspace_blob: Any = None,
    ) -> None:
        self.id = id
        self.workflow_id = workflow_id
        self.key = key
        self.phase = phase
        self.resume_action = resume_action
        self.task_id = task_id
        self.task_name = task_name
        self.status = status
        self.created_at = created_at
        self.data = dict(data)
        self.tasks = list(tasks)
        self.workflow = workflow
        self.parent_workflow_id = parent_workflow_id
        self.workspace_blob = workspace_blob

    def to_summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "workflow_id": self.workflow_id,
            "parent_workflow_id": getattr(self, "parent_workflow_id", None),
            "key": self.key,
            "phase": self.phase,
            "resume_action": self.resume_action,
            "task_id": self.task_id,
            "task_name": self.task_name,
            "status": self.status,
            "created_at": self.created_at,
            "data": dict(self.data),
            "tasks": list(self.tasks),
        }

    def to_dict(self) -> dict[str, Any]:
        result = self.to_summary()
        result["workflow"] = self.workflow
        result["workspace_blob"] = self.workspace_blob
        return result


class WorkflowInstance(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """Active persistent workflow execution entity."""

    def __init__(
        self,
        workflow_id: str,
        process_id: str,
        bpmn_path: str,
        status: str,
        workflow: Any,
        data: dict[str, Any] | None = None,
        tasks: list[dict[str, Any]] | None = None,
        jobs: dict[str, Any] | None = None,
        save_points: list[dict[str, Any]] | None = None,
        events: list[dict[str, Any]] | None = None,
        failure_reason: str | None = None,
        failure_history: list[dict[str, Any]] | None = None,
        forked_from: str | None = None,
        forked_from_save_point: str | None = None,
        parent_workflow_id: str | None = None,
        created_at: str | None = None,
        updated_at: str | None = None,
        workspace_blob: Any = None,
        **extra: Any,
    ) -> None:
        self.workflow_id = workflow_id
        self.process_id = process_id
        self.bpmn_path = bpmn_path
        self.status = status
        self.workflow = workflow
        self.data = PersistentMapping(data or {})
        self.jobs = PersistentMapping(jobs or {})
        self.tasks = PersistentList(tasks or [])
        self.save_points = PersistentList(save_points or [])
        self.events = PersistentList(events or [])
        self.failure_reason = failure_reason
        self.failure_history = PersistentList(failure_history or [])
        self.forked_from = forked_from
        self.forked_from_save_point = forked_from_save_point
        self.parent_workflow_id = parent_workflow_id
        now = datetime.now(timezone.utc).isoformat()
        self.created_at = created_at or now
        self.updated_at = updated_at or now
        self.workspace_blob = workspace_blob
        self.workspace_archive: bytes | None = extra.pop("workspace_archive", None)
        self.extra = PersistentMapping(extra)

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflow_id": self.workflow_id,
            "parent_workflow_id": getattr(self, "parent_workflow_id", None),
            "process_id": self.process_id,
            "bpmn_path": self.bpmn_path,
            "status": self.status,
            "workflow": self.workflow,
            "data": dict(self.data),
            "jobs": dict(self.jobs),
            "tasks": list(self.tasks),
            "save_points": list(self.save_points),
            "events": [dict(e) if isinstance(e, PersistentMapping) else e for e in getattr(self, "events", [])],
            "failure_reason": self.failure_reason,
            "failure_history": list(self.failure_history),
            "forked_from": self.forked_from,
            "forked_from_save_point": self.forked_from_save_point,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            **dict(self.extra),
        }


#: Record keys mapped to first-class WorkflowInstance attributes. Anything else a caller
#: puts on a record (pi_session_id, network, policy_error, ...) is kept in `extra` rather
#: than silently dropped on save.
_INSTANCE_FIELDS = frozenset({
    "workflow_id", "process_id", "bpmn_path", "status", "workflow", "data", "jobs",
    "tasks", "save_points", "events", "failure_reason", "failure_history", "forked_from",
    "forked_from_save_point", "parent_workflow_id", "created_at", "updated_at",
    "workspace_blob", "workspace_archive",
})


class WorkflowStore:
    """Idiomatic ZODB repository using OOBTree collections, Persistent entities, and compaction."""

    def __init__(self, path: str = "data/workflows.fs") -> None:
        self.path = path
        storage, self._temp_blob_dir = _create_storage(path)
        self.db = DB(storage)
        with self.db.transaction() as connection:
            root = connection.root()
            if "workflows" not in root:
                root["workflows"] = OOBTree()
            if "save_points" not in root:
                root["save_points"] = OOBTree()
            if "metadata" not in root:
                root["metadata"] = OOBTree()
            if "webhooks" not in root:
                root["webhooks"] = OOBTree()

    def close(self) -> None:
        self.db.close()
        if self._temp_blob_dir and os.path.exists(self._temp_blob_dir):
            import shutil
            shutil.rmtree(self._temp_blob_dir, ignore_errors=True)

    @staticmethod
    def _format_bytes(size: int) -> str:
        s = float(size)
        for unit in ["B", "KB", "MB", "GB"]:
            if s < 1024.0 or unit == "GB":
                return f"{s:.1f} {unit}" if unit != "B" else f"{int(s)} B"
            s /= 1024.0
        return f"{s:.1f} GB"

    @_retry_on_conflict()
    def save_save_point(self, snapshot_or_dict: SavePointSnapshot | dict[str, Any]) -> SavePointSnapshot:
        d = snapshot_or_dict.to_dict() if hasattr(snapshot_or_dict, "to_dict") else dict(snapshot_or_dict)
        with self.db.transaction() as connection:
            root = connection.root()
            snapshot = SavePointSnapshot(
                id=d["id"],
                workflow_id=d.get("workflow_id", ""),
                key=d.get("key", ""),
                phase=d.get("phase", ""),
                resume_action=d.get("resume_action", ""),
                task_id=d.get("task_id", ""),
                task_name=d.get("task_name", ""),
                status=d.get("status", "running"),
                created_at=d.get("created_at", datetime.now(timezone.utc).isoformat()),
                data=d.get("data", {}),
                tasks=d.get("tasks", []),
                workflow=d.get("workflow"),
                parent_workflow_id=d.get("parent_workflow_id"),
                workspace_blob=d.get("workspace_blob"),
            )
            root["save_points"][snapshot.id] = snapshot
        return snapshot

    @_retry_on_conflict()
    def delete_save_point(self, save_point_id: str) -> bool:
        with self.db.transaction() as connection:
            root = connection.root()
            if save_point_id in root["save_points"]:
                del root["save_points"][save_point_id]
                return True
            return False

    def load_save_point(self, save_point_id: str) -> dict[str, Any] | None:
        with self.db.transaction() as connection:
            root = connection.root()
            sp = root["save_points"].get(save_point_id)
            if sp is not None:
                result = sp.to_dict() if hasattr(sp, "to_dict") else dict(sp)
                if result.get("workflow") is not None:
                    migrate_workflow_object(result["workflow"])
                blob = result.get("workspace_blob")
                if blob is not None:
                    # The stored Blob is a persistent object referenced from `sp`; reading
                    # it back into a standalone copy here, while the connection is still
                    # open, means the caller gets an independent Blob that survives past
                    # this transaction instead of a ghost reference to a closed connection.
                    with blob.open("r") as f:
                        content = f.read()
                    standalone = Blob()
                    with standalone.open("w") as f:
                        f.write(content)
                    result["workspace_blob"] = standalone
                return result
            return None

    @_retry_on_conflict()
    def save(self, workflow_id: str, record: dict[str, Any] | WorkflowInstance) -> None:
        with self.db.transaction() as connection:
            root = connection.root()
            save_points_root = root["save_points"]
            workflows_root = root["workflows"]
            metadata_root = root["metadata"]

            existing = workflows_root.get(workflow_id)

            if isinstance(record, WorkflowInstance):
                instance = record
                summaries = list(instance.save_points)
                raw_record = instance.to_dict()
                if existing is not None and existing is not instance and isinstance(existing, WorkflowInstance):
                    existing.process_id = instance.process_id
                    existing.bpmn_path = instance.bpmn_path
                    existing.status = instance.status
                    existing.workflow = instance.workflow
                    existing.data.clear()
                    existing.data.update(dict(instance.data))
                    existing.jobs.clear()
                    existing.jobs.update(dict(instance.jobs))
                    existing.tasks = PersistentList(list(instance.tasks))
                    existing.save_points = PersistentList(list(instance.save_points))
                    existing.events = PersistentList(list(instance.events))
                    existing.failure_reason = instance.failure_reason
                    existing.failure_history = PersistentList(list(instance.failure_history))
                    existing.forked_from = instance.forked_from
                    existing.forked_from_save_point = instance.forked_from_save_point
                    existing.parent_workflow_id = getattr(instance, "parent_workflow_id", None)
                    existing.updated_at = instance.updated_at
                    existing.workspace_blob = instance.workspace_blob
                    existing.workspace_archive = instance.workspace_archive
                    existing._p_changed = True
                    instance = existing
                else:
                    workflows_root[workflow_id] = instance
            else:
                raw_record = dict(record)
                raw_save_points = raw_record.get("save_points", [])
                summaries = []
                for point in raw_save_points:
                    if isinstance(point, SavePointSnapshot):
                        save_points_root[point.id] = point
                        summaries.append(point.to_summary())
                    elif isinstance(point, dict) and "id" in point:
                        point_id = point["id"]
                        if point.get("workflow") is not None:
                            snapshot = SavePointSnapshot(
                                id=point_id,
                                workflow_id=workflow_id,
                                key=point.get("key", ""),
                                phase=point.get("phase", ""),
                                resume_action=point.get("resume_action", ""),
                                task_id=point.get("task_id", ""),
                                task_name=point.get("task_name", ""),
                                status=point.get("status", "running"),
                                created_at=point.get("created_at", datetime.now(timezone.utc).isoformat()),
                                data=point.get("data", {}),
                                tasks=point.get("tasks", []),
                                workflow=point.get("workflow"),
                                parent_workflow_id=point.get("parent_workflow_id"),
                                workspace_blob=point.get("workspace_blob"),
                            )
                            save_points_root[point_id] = snapshot
                            summaries.append(snapshot.to_summary())
                        else:
                            summaries.append(point)
                    else:
                        summaries.append(point)

                created_at = (
                    getattr(existing, "created_at", None)
                    or (existing.get("created_at") if isinstance(existing, dict) else None)
                    or (summaries[0]["created_at"] if summaries else None)
                    or raw_record.get("created_at")
                    or datetime.now(timezone.utc).isoformat()
                )
                updated_at = (
                    (summaries[-1]["created_at"] if summaries else None)
                    or raw_record.get("updated_at")
                    or datetime.now(timezone.utc).isoformat()
                )

                if existing and hasattr(existing, "events"):
                    existing_events = list(existing.events)
                    raw_events = raw_record.get("events")
                    if raw_events:
                        events = raw_events
                    else:
                        events = existing_events
                else:
                    events = raw_record.get("events", [])

                workspace_blob = (
                    raw_record.get("workspace_blob")
                    or getattr(existing, "workspace_blob", None)
                )
                workspace_archive = (
                    raw_record.get("workspace_archive")
                    or getattr(existing, "workspace_archive", None)
                )

                if existing is not None and isinstance(existing, WorkflowInstance):
                    instance = existing
                    instance.process_id = raw_record.get("process_id", instance.process_id)
                    instance.bpmn_path = raw_record.get("bpmn_path", instance.bpmn_path)
                    instance.status = raw_record.get("status", instance.status)
                    instance.workflow = raw_record.get("workflow", instance.workflow)
                    instance.data.clear()
                    instance.data.update(raw_record.get("data", {}))
                    instance.jobs.clear()
                    instance.jobs.update(raw_record.get("jobs", {}))
                    instance.tasks = PersistentList(raw_record.get("tasks", []))
                    instance.save_points = PersistentList(summaries)
                    if not hasattr(instance, "events"):
                        instance.events = PersistentList()
                    raw_events = raw_record.get("events", [])
                    if raw_events:
                        existing_events_set = {
                            (e.get("timestamp"), e.get("event_type"), e.get("task_id"))
                            if isinstance(e, (dict, PersistentMapping)) else (getattr(e, "timestamp", None), getattr(e, "event_type", None), getattr(e, "task_id", None))
                            for e in instance.events
                        }
                        for e in raw_events:
                            e_dict = dict(e) if isinstance(e, (dict, PersistentMapping)) else (e.to_dict() if hasattr(e, "to_dict") else vars(e))
                            key = (e_dict.get("timestamp"), e_dict.get("event_type"), e_dict.get("task_id"))
                            if key not in existing_events_set:
                                instance.events.append(PersistentMapping(e_dict))
                                existing_events_set.add(key)
                    instance.failure_reason = raw_record.get("failure_reason")
                    instance.failure_history = PersistentList(raw_record.get("failure_history", []))
                    instance.forked_from = raw_record.get("forked_from", instance.forked_from)
                    instance.forked_from_save_point = raw_record.get("forked_from_save_point", instance.forked_from_save_point)
                    instance.parent_workflow_id = raw_record.get("parent_workflow_id", getattr(instance, "parent_workflow_id", None))
                    instance.created_at = created_at
                    instance.updated_at = updated_at
                    if workspace_blob is not None:
                        instance.workspace_blob = workspace_blob
                    if workspace_archive is not None:
                        instance.workspace_archive = workspace_archive
                    if not hasattr(instance, "extra"):
                        instance.extra = PersistentMapping()
                    for extra_key, extra_value in raw_record.items():
                        if extra_key not in _INSTANCE_FIELDS:
                            instance.extra[extra_key] = extra_value
                    instance._p_changed = True
                else:
                    events = [
                        PersistentMapping(e) if isinstance(e, dict) else e
                        for e in raw_record.get("events", [])
                    ]
                    instance = WorkflowInstance(
                        workflow_id=workflow_id,
                        process_id=raw_record.get("process_id", ""),
                        bpmn_path=raw_record.get("bpmn_path", ""),
                        status=raw_record.get("status", "running"),
                        workflow=raw_record.get("workflow"),
                        data=raw_record.get("data", {}),
                        tasks=raw_record.get("tasks", []),
                        jobs=raw_record.get("jobs", {}),
                        save_points=summaries,
                        events=events,
                        failure_reason=raw_record.get("failure_reason"),
                        failure_history=raw_record.get("failure_history", []),
                        forked_from=raw_record.get("forked_from"),
                        forked_from_save_point=raw_record.get("forked_from_save_point"),
                        parent_workflow_id=raw_record.get("parent_workflow_id"),
                        created_at=created_at,
                        updated_at=updated_at,
                        workspace_blob=workspace_blob,
                        workspace_archive=workspace_archive,
                        **{k: v for k, v in raw_record.items() if k not in _INSTANCE_FIELDS},
                    )
                    workflows_root[workflow_id] = instance

            ws_meta = raw_record.get("workspace_metadata") or (raw_record.get("data", {}).get("workspace_metadata") if isinstance(raw_record.get("data"), dict) else {})
            if not ws_meta and existing is not None:
                ws_meta = getattr(existing, "workspace_metadata", {})

            if workflow_id in metadata_root and isinstance(metadata_root[workflow_id], WorkflowMetadata):
                metadata = metadata_root[workflow_id]
                metadata.process_id = instance.process_id
                metadata.bpmn_path = instance.bpmn_path
                metadata.status = instance.status
                metadata.task_count = len(instance.tasks)
                metadata.save_point_count = len(instance.save_points)
                metadata.updated_at = instance.updated_at
                metadata.data = dict(instance.data)
                metadata.failure_reason = instance.failure_reason
                metadata.parent_workflow_id = getattr(instance, "parent_workflow_id", None)
                metadata.workspace_metadata = dict(ws_meta)
                metadata._p_changed = True
            else:
                metadata = WorkflowMetadata(
                    workflow_id=instance.workflow_id,
                    process_id=instance.process_id,
                    bpmn_path=instance.bpmn_path,
                    status=instance.status,
                    task_count=len(instance.tasks),
                    save_point_count=len(instance.save_points),
                    created_at=instance.created_at,
                    updated_at=instance.updated_at,
                    data=dict(instance.data),
                    failure_reason=instance.failure_reason,
                    parent_workflow_id=getattr(instance, "parent_workflow_id", None),
                    workspace_metadata=ws_meta,
                )
                metadata_root[workflow_id] = metadata

    def get_workspace_metadata(self, workflow_id: str) -> dict[str, Any]:
        with self.db.transaction() as connection:
            root = connection.root()
            if "metadata" in root and workflow_id in root["metadata"]:
                meta = root["metadata"][workflow_id]
                return dict(getattr(meta, "workspace_metadata", {}))
            wf = root["workflows"].get(workflow_id)
            if wf is not None:
                ws_meta = getattr(wf, "workspace_metadata", None)
                if ws_meta:
                    return dict(ws_meta)
                if hasattr(wf, "data") and isinstance(wf.data, (dict, PersistentMapping)):
                    return dict(wf.data.get("workspace_metadata", {}))
            return {}

    def load(self, workflow_id: str) -> dict[str, Any] | None:
        with self.db.transaction() as connection:
            root = connection.root()
            record = root["workflows"].get(workflow_id)
            if record is None:
                return None
            result = record.to_dict() if hasattr(record, "to_dict") else dict(record)
            if result.get("workflow") is not None:
                migrate_workflow_object(result["workflow"])
            return result

    @_retry_on_conflict()
    def append_event(self, workflow_id: str, event_dict: dict[str, Any]) -> None:
        with self.db.transaction() as connection:
            root = connection.root()
            wf = root["workflows"].get(workflow_id)
            if wf is not None:
                if not hasattr(wf, "events"):
                    wf.events = PersistentList()
                wf.events.append(PersistentMapping(event_dict))

    def get_events(self, workflow_id: str) -> list[dict[str, Any]]:
        with self.db.transaction() as connection:
            root = connection.root()
            wf = root["workflows"].get(workflow_id)
            if wf is None:
                return []
            events = getattr(wf, "events", [])
            return [dict(e) if isinstance(e, PersistentMapping) else e for e in events]

    @_retry_on_conflict()
    def register_webhook(self, url: str, events: list[str] | None = None) -> dict[str, Any]:
        webhook_id = uuid.uuid4().hex
        webhook_data = {
            "id": webhook_id,
            "url": url,
            "events": list(events or []),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with self.db.transaction() as connection:
            root = connection.root()
            if "webhooks" not in root:
                root["webhooks"] = OOBTree()
            root["webhooks"][webhook_id] = PersistentMapping(webhook_data)
        return webhook_data

    def list_webhooks(self) -> list[dict[str, Any]]:
        with self.db.transaction() as connection:
            root = connection.root()
            if "webhooks" not in root:
                return []
            return [dict(wh) for wh in root["webhooks"].values()]

    @_retry_on_conflict()
    def delete_webhook(self, webhook_id: str) -> bool:
        with self.db.transaction() as connection:
            root = connection.root()
            if "webhooks" in root and webhook_id in root["webhooks"]:
                del root["webhooks"][webhook_id]
                return True
            return False

    def list_metadata(
        self,
        status_filter: str | None = None,
        limit: int | None = None,
        offset: int = 0,
        since: str | None = None,
        until: str | None = None,
    ) -> list[dict[str, Any]]:
        with self.db.transaction() as connection:
            root = connection.root()
            metadata_tree = root.get("metadata", {})
            workflows_tree = root.get("workflows", {})
            if len(metadata_tree) == 0 and len(workflows_tree) > 0:
                for wf_id, wf in workflows_tree.items():
                    if isinstance(wf, WorkflowInstance):
                        meta = WorkflowMetadata(
                            workflow_id=wf.workflow_id,
                            process_id=wf.process_id,
                            bpmn_path=wf.bpmn_path,
                            status=wf.status,
                            task_count=len(wf.tasks),
                            save_point_count=len(wf.save_points),
                            created_at=wf.created_at,
                            updated_at=wf.updated_at,
                            data=dict(wf.data),
                            failure_reason=wf.failure_reason,
                            parent_workflow_id=getattr(wf, "parent_workflow_id", None),
                        )
                    else:
                        d = dict(wf)
                        sps = d.get("save_points", [])
                        meta = WorkflowMetadata(
                            workflow_id=wf_id,
                            process_id=d.get("process_id", ""),
                            bpmn_path=d.get("bpmn_path", ""),
                            status=d.get("status", "unknown"),
                            task_count=len(d.get("tasks", [])),
                            save_point_count=len(sps),
                            created_at=sps[0].get("created_at") if sps and isinstance(sps[0], dict) else d.get("created_at"),
                            updated_at=sps[-1].get("created_at") if sps and isinstance(sps[-1], dict) else d.get("updated_at"),
                            data=d.get("data", {}),
                            failure_reason=d.get("failure_reason"),
                            parent_workflow_id=d.get("parent_workflow_id"),
                        )
                    metadata_tree[wf_id] = meta

            results = []
            for meta in metadata_tree.values():
                item = meta.to_dict() if hasattr(meta, "to_dict") else dict(meta)
                if status_filter and status_filter != "all" and item.get("status") != status_filter:
                    continue
                created_at = item.get("created_at") or ""
                if since and created_at < since:
                    continue
                if until and created_at > until:
                    continue
                results.append(item)
            results.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
            if offset > 0:
                results = results[offset:]
            if limit is not None and limit >= 0:
                results = results[:limit]
            return results

    def list(self) -> list[tuple[str, dict[str, Any]]]:
        with self.db.transaction() as connection:
            root = connection.root()
            return [
                (wf_id, wf.to_dict() if hasattr(wf, "to_dict") else dict(wf))
                for wf_id, wf in root["workflows"].items()
            ]

    @_retry_on_conflict()
    def delete(self, workflow_id: str) -> bool:
        with self.db.transaction() as connection:
            root = connection.root()
            workflows = root["workflows"]
            if workflow_id not in workflows:
                return False
            wf = workflows[workflow_id]
            points = getattr(wf, "save_points", wf.get("save_points", []) if isinstance(wf, dict) else []) or []
            for p in points:
                p_id = p.get("id") if isinstance(p, dict) else getattr(p, "id", None)
                if p_id and p_id in root["save_points"]:
                    del root["save_points"][p_id]
            del workflows[workflow_id]
            if workflow_id in root["metadata"]:
                del root["metadata"][workflow_id]
            return True

    @_retry_on_conflict()
    def clear(self) -> int:
        with self.db.transaction() as connection:
            root = connection.root()
            count = len(root["workflows"])
            root["workflows"].clear()
            root["save_points"].clear()
            root["metadata"].clear()
            return count

    @_retry_on_conflict()
    def update(self, workflow_id: str, **changes: Any) -> dict[str, Any]:
        with self.db.transaction() as connection:
            root = connection.root()
            wf = root["workflows"].get(workflow_id)
            if wf is None:
                raise KeyError(workflow_id)
            if isinstance(wf, WorkflowInstance):
                for k, v in changes.items():
                    if k == "data" and isinstance(v, dict):
                        wf.data.clear()
                        wf.data.update(v)
                    elif k == "jobs" and isinstance(v, dict):
                        wf.jobs.clear()
                        wf.jobs.update(v)
                    elif k == "tasks" and isinstance(v, list):
                        wf.tasks = PersistentList(v)
                    elif k == "save_points" and isinstance(v, list):
                        wf.save_points = PersistentList(v)
                    elif k == "failure_history" and isinstance(v, list):
                        wf.failure_history = PersistentList(v)
                    elif hasattr(wf, k):
                        setattr(wf, k, v)
                    else:
                        wf.extra[k] = v
                wf.updated_at = datetime.now(timezone.utc).isoformat()
                wf._p_changed = True

                if workflow_id in root["metadata"]:
                    meta = root["metadata"][workflow_id]
                    meta.status = wf.status
                    meta.task_count = len(wf.tasks)
                    meta.save_point_count = len(wf.save_points)
                    meta.updated_at = wf.updated_at
                    meta.data = dict(wf.data)
                    meta.failure_reason = wf.failure_reason
                    meta._p_changed = True

                return wf.to_dict()
            else:
                wf_dict = dict(wf)
                wf_dict.update(changes)
                root["workflows"][workflow_id] = wf_dict
                return wf_dict

    def pack(self, days: int = 0) -> dict[str, Any]:
        is_file = self.path != ":memory:" and Path(self.path).is_file()
        size_before = Path(self.path).stat().st_size if is_file else 0
        pack_time = time.time() - (days * 86400)
        self.db.pack(pack_time)
        size_after = Path(self.path).stat().st_size if is_file else 0
        reclaimed = max(0, size_before - size_after)
        return {
            "path": self.path,
            "size_before_bytes": size_before,
            "size_after_bytes": size_after,
            "reclaimed_bytes": reclaimed,
            "size_before_human": self._format_bytes(size_before),
            "size_after_human": self._format_bytes(size_after),
            "reclaimed_human": self._format_bytes(reclaimed),
        }

    def storage_stats(self) -> dict[str, Any]:
        is_file = self.path != ":memory:" and Path(self.path).is_file()
        size_bytes = Path(self.path).stat().st_size if is_file else 0
        with self.db.transaction() as connection:
            root = connection.root()
            instances_count = len(root.get("workflows", {}))
            save_points_count = len(root.get("save_points", {}))
        return {
            "storage_type": "memory" if self.path == ":memory:" else "file",
            "path": self.path,
            "size_bytes": size_bytes,
            "size_human": self._format_bytes(size_bytes),
            "instances_count": instances_count,
            "save_points_count": save_points_count,
        }

    def get_workspace(self, workflow_id: str) -> Any | None:
        with self.db.transaction() as connection:
            root = connection.root()
            instance = root["workflows"].get(workflow_id)
            if instance is not None:
                if getattr(instance, "workspace_archive", None):
                    return instance.workspace_archive
                blob = getattr(instance, "workspace_blob", None)
                if blob is not None:
                    try:
                        with blob.open("r") as f:
                            return f.read()
                    except Exception:
                        return None
            return None

    @_retry_on_conflict()
    def set_workspace(self, workflow_id: str, blob_or_bytes: Any) -> None:
        with self.db.transaction() as connection:
            root = connection.root()
            instance = root["workflows"].get(workflow_id)
            if instance is not None:
                if isinstance(blob_or_bytes, bytes):
                    blob = Blob()
                    with blob.open("w") as f:
                        f.write(blob_or_bytes)
                    instance.workspace_blob = blob
                    instance.workspace_archive = None
                else:
                    instance.workspace_blob = blob_or_bytes
                    instance.workspace_archive = None
                instance._p_changed = True

