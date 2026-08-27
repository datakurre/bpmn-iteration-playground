from __future__ import annotations

import os
import tempfile
import time
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from functools import wraps
from pathlib import Path
from typing import Any, TypeVar

from BTrees.OOBTree import OOBTree
from persistent import Persistent
from persistent.list import PersistentList
from persistent.mapping import PersistentMapping
from ZODB import DB
from ZODB.blob import Blob, BlobStorage
from ZODB.FileStorage import FileStorage
from ZODB.MappingStorage import MappingStorage
from ZODB.POSException import ConflictError

from graph_agent.agents_root import get_state_dir
from graph_agent.migrations import migrate_workflow_object

F = TypeVar("F", bound=Callable[..., Any])


class WorkspaceConflictError(Exception):
    """Raised by set_workspace when expected_version no longer matches the stored version.

    Interim optimistic-concurrency guard: two concurrent agent turns on the same instance
    still share one workspace and cannot merge their changes. The real fix is a workspace
    per branch (git worktree model), not yet designed -- see plans/data.md "Not a backlog
    item: the worktree model". This only turns a silent overwrite into a loud, retryable
    failure; it is deliberately not retried automatically here.
    """


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
                    time.sleep(0.02 * (2**attempt))

        return wrapper  # type: ignore[return-value]

    return decorator


def _safe_blob_copy(b: Any) -> Any:
    if isinstance(b, Blob):
        new_b = Blob()
        with b.open("r") as src, new_b.open("w") as dst:
            dst.write(src.read())
        return new_b
    elif isinstance(b, bytes):
        new_b = Blob()
        with new_b.open("w") as dst:
            dst.write(b)
        return new_b
    return b


def _create_storage(path: str | Path) -> tuple[Any, str | None]:
    """Create ZODB storage, supporting in-memory or local FileStorage.

    No remote ZEO option: state is local to the workspace (`.agents/state/`) now, not a
    service several processes share, so there is nothing left for a remote store to share
    it with. (Removed in the meta-agent refactor's phase 1 -- see
    docs/meta-agent-refactor-plan.md.)
    """
    path_str = str(path)
    if path_str == ":memory:":
        blob_dir = tempfile.mkdtemp(prefix="bpmn-blobs-")
        return BlobStorage(blob_dir, MappingStorage()), blob_dir
    p = Path(path_str)
    if p.is_dir():
        db_path = p / "Data.fs"
        blob_dir = str(p / "blobs")
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        db_path = p
        blob_dir = str(p.parent / "blobs")
    Path(blob_dir).mkdir(parents=True, exist_ok=True)
    return BlobStorage(blob_dir, FileStorage(str(db_path))), None


class WorkflowMetadata(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """Lightweight metadata for fast listing and indexing."""

    def __init__(  # noqa: PLR0913 -- plain data holder, one field per constructor arg
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
        merge_status: str | None = None,
        merge_error: str | None = None,
        merged_at: str | None = None,
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
        self.merge_status = merge_status
        self.merge_error = merge_error
        self.merged_at = merged_at

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
            "merge_status": getattr(self, "merge_status", None),
            "merge_error": getattr(self, "merge_error", None),
            "merged_at": getattr(self, "merged_at", None),
        }


class Scope(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """One execution-tree node's local variable scope, ZODB-native.

    Written once a scoped BPMN element (currently ServiceTask and UserTask -- see
    docs/variable-scoping-plan.md) enters and again when it completes; `inputs`/`outputs`
    are the resolved camunda:inputParameter/outputParameter values, kept as an audit trail
    independent of whatever the element did with them afterward. A completed Scope *is* the
    history record for that element -- no deep-copied workflow graph needed to answer "what
    did this step see, what did it publish".
    """

    def __init__(  # noqa: PLR0913 -- plain data holder, one field per constructor arg
        self,
        id: str,
        workflow_id: str,
        bpmn_id: str,
        bpmn_name: str,
        element_type: str,
        parent_scope_id: str | None,
        status: str,
        entered_at: str,
        inputs: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        outputs: dict[str, Any] | None = None,
        completed_at: str | None = None,
    ) -> None:
        self.id = id
        self.workflow_id = workflow_id
        self.bpmn_id = bpmn_id
        self.bpmn_name = bpmn_name
        self.element_type = element_type
        self.parent_scope_id = parent_scope_id
        self.status = status
        self.entered_at = entered_at
        self.inputs = PersistentMapping(inputs or {})
        self.data = PersistentMapping(data or {})
        self.outputs = PersistentMapping(outputs or {})
        self.completed_at = completed_at

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "workflow_id": self.workflow_id,
            "bpmn_id": self.bpmn_id,
            "bpmn_name": self.bpmn_name,
            "element_type": self.element_type,
            "parent_scope_id": self.parent_scope_id,
            "status": self.status,
            "entered_at": self.entered_at,
            "inputs": dict(self.inputs),
            "data": dict(self.data),
            "outputs": dict(self.outputs),
            "completed_at": self.completed_at,
        }


class SessionRecord(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """Persistent record for agent sessions in ZODB."""

    def __init__(
        self,
        session_id: str,
        workflow_id: str | None = None,
        task_id: str | None = None,
        harness_type: str | None = None,
        parent_session_id: str | None = None,
        created_at: str | None = None,
        updated_at: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        self.session_id = session_id
        self.workflow_id = workflow_id
        self.task_id = task_id
        self.harness_type = harness_type
        self.parent_session_id = parent_session_id
        now = datetime.now(UTC).isoformat()
        self.created_at = created_at or now
        self.updated_at = updated_at or now
        self.data = PersistentMapping(data or {})

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "workflow_id": self.workflow_id,
            "task_id": self.task_id,
            "harness_type": self.harness_type,
            "parent_session_id": self.parent_session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "data": dict(self.data),
        }


class SavePointSnapshot(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """Independent persistent snapshot holding a deepcopied SpiffWorkflow object graph."""

    def __init__(  # noqa: PLR0913 -- plain data holder, one field per constructor arg
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
        workspace_ref: Any = None,
        supports_snapshot: bool = True,
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
        # A WorktreeStrategy savepoint's checkpoint (a git commit SHA), mutually exclusive
        # with workspace_blob -- BlobStrategy sets one, WorktreeStrategy the other, and an
        # InPlaceStrategy savepoint (supports_snapshot=False) sets neither.
        self.workspace_ref = workspace_ref
        # Mirrors the strategy's own `supports_snapshot` at capture time -- the
        # unambiguous signal fork.py needs to reject an in-place-sourced savepoint rather
        # than guessing intent from workspace_blob/workspace_ref both being empty (which
        # also legitimately happens for a BlobStrategy savepoint captured before any
        # workspace existed yet). Defaults True: every savepoint persisted before this
        # field existed was captured under the blob-only world, where snapshot always
        # meant "yes, blob-restorable".
        self.supports_snapshot = supports_snapshot

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
        result["workspace_ref"] = getattr(self, "workspace_ref", None)
        result["supports_snapshot"] = getattr(self, "supports_snapshot", True)
        return result


class WorkflowInstance(Persistent):  # type: ignore[misc]  # persistent ships no type stubs
    """Active persistent workflow execution entity."""

    def __init__(  # noqa: PLR0913 -- plain data holder, one field per constructor arg
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
        workspace_version: int = 0,
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
        #: Scope objects for this instance's execution tree, keyed by their own id (see
        #: `Scope`). Deliberately kept out of `to_dict()`/`save()`'s generic reconciliation --
        #: `record_scope`/`list_scopes` mutate this tree directly, the same way
        #: `save_save_point`/`load_save_point` manage save points independently of it.
        self.scopes = OOBTree()
        self.events = PersistentList(events or [])
        self.failure_reason = failure_reason
        self.failure_history = PersistentList(failure_history or [])
        self.forked_from = forked_from
        self.forked_from_save_point = forked_from_save_point
        self.parent_workflow_id = parent_workflow_id
        now = datetime.now(UTC).isoformat()
        self.created_at = created_at or now
        self.updated_at = updated_at or now
        self.workspace_blob = workspace_blob
        self.workspace_archive: bytes | None = extra.pop("workspace_archive", None)
        self.workspace_version = workspace_version
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
_INSTANCE_FIELDS = frozenset(
    {
        "workflow_id",
        "process_id",
        "bpmn_path",
        "status",
        "workflow",
        "data",
        "jobs",
        "tasks",
        "save_points",
        "events",
        "failure_reason",
        "failure_history",
        "forked_from",
        "forked_from_save_point",
        "parent_workflow_id",
        "created_at",
        "updated_at",
        "workspace_blob",
        "workspace_archive",
        "workspace_version",
    }
)


class WorkflowStore:
    """Idiomatic ZODB repository using OOBTree collections, Persistent entities, and compaction."""

    def __init__(self, path: str | Path | None = None) -> None:
        if path is None:
            state_dir = get_state_dir()
            state_dir.mkdir(parents=True, exist_ok=True)
            path = str(state_dir / "Data.fs")
        self.path = str(path)
        storage, self._temp_blob_dir = _create_storage(self.path)
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
            if "projects" not in root:
                root["projects"] = OOBTree()
            if "sessions" not in root:
                root["sessions"] = OOBTree()

    @_retry_on_conflict()
    def save_session(
        self,
        session_id: str,
        data_or_record: dict[str, Any] | SessionRecord,
    ) -> dict[str, Any]:
        """Save or update an agent session record in ZODB."""
        with self.db.transaction() as connection:
            root = connection.root()
            if "sessions" not in root:
                root["sessions"] = OOBTree()
            sessions = root["sessions"]
            if isinstance(data_or_record, SessionRecord):
                record = data_or_record
            else:
                d = dict(data_or_record)
                existing = sessions.get(session_id)
                if existing is not None and isinstance(existing, SessionRecord):
                    existing.workflow_id = d.get("workflow_id", existing.workflow_id)
                    existing.task_id = d.get("task_id", existing.task_id)
                    existing.harness_type = d.get("harness_type", existing.harness_type)
                    existing.parent_session_id = d.get("parent_session_id", existing.parent_session_id)
                    existing.updated_at = d.get("updated_at", datetime.now(UTC).isoformat())
                    if "data" in d and isinstance(d["data"], dict):
                        existing.data.update(d["data"])
                    existing._p_changed = True
                    return existing.to_dict()
                else:
                    record = SessionRecord(
                        session_id=session_id,
                        workflow_id=d.get("workflow_id"),
                        task_id=d.get("task_id"),
                        harness_type=d.get("harness_type"),
                        parent_session_id=d.get("parent_session_id"),
                        created_at=d.get("created_at"),
                        updated_at=d.get("updated_at"),
                        data=d.get("data", {}),
                    )
            sessions[session_id] = record
            return record.to_dict()

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        """Get an agent session record by ID from ZODB."""
        with self.db.transaction() as connection:
            root = connection.root()
            if "sessions" not in root:
                return None
            record = root["sessions"].get(session_id)
            if record is None:
                return None
            return record.to_dict() if hasattr(record, "to_dict") else dict(record)

    def list_sessions(self, workflow_id: str | None = None) -> list[dict[str, Any]]:
        """List agent sessions from ZODB, optionally filtered by workflow_id."""
        with self.db.transaction() as connection:
            root = connection.root()
            if "sessions" not in root:
                return []
            sessions = root["sessions"]
            results = []
            for s in sessions.values():
                d = s.to_dict() if hasattr(s, "to_dict") else dict(s)
                if workflow_id is None or d.get("workflow_id") == workflow_id:
                    results.append(d)
            return sorted(results, key=lambda x: str(x.get("created_at", "")), reverse=True)

    @_retry_on_conflict()
    def delete_session(self, session_id: str) -> bool:
        """Delete a session from ZODB."""
        with self.db.transaction() as connection:
            root = connection.root()
            if "sessions" not in root:
                return False
            if session_id in root["sessions"]:
                del root["sessions"][session_id]
                return True
            return False

    @_retry_on_conflict()
    def get_project_state(self, workflow_id: str) -> dict[str, Any]:
        """Project-scoped state for a root workflow, or ``{}`` if it has none.

        A **side store, not an identity record** (plans/concepts.md "Project identity is
        convention, not a record"). It answers "what has been hung on this Project" -- repo
        assignment, issues, decision log -- and never "does this Project
        exist"; a Project is valid with no entry here at all, so a miss is an empty dict
        rather than a ``KeyError``.

        It lives outside ``workflow.data`` on purpose: this state grows for the life of a
        Project (months), and everything in ``workflow.data`` is deep-copied into every
        savepoint. It is consequently **not** carried by a fork.
        """
        with self.db.transaction() as connection:
            state = connection.root()["projects"].get(workflow_id)
            return dict(state) if state else {}

    @_retry_on_conflict()
    def set_project_state(self, workflow_id: str, state: dict[str, Any]) -> dict[str, Any]:
        """Replace the Project-scoped state for a root workflow."""
        with self.db.transaction() as connection:
            connection.root()["projects"][workflow_id] = dict(state)
            return dict(state)

    @_retry_on_conflict()
    def delete_project_state(self, workflow_id: str) -> bool:
        with self.db.transaction() as connection:
            projects = connection.root()["projects"]
            if workflow_id not in projects:
                return False
            del projects[workflow_id]
            return True

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
                created_at=d.get("created_at", datetime.now(UTC).isoformat()),
                data=d.get("data", {}),
                tasks=d.get("tasks", []),
                workflow=d.get("workflow"),
                parent_workflow_id=d.get("parent_workflow_id"),
                workspace_blob=_safe_blob_copy(d.get("workspace_blob")),
                workspace_ref=d.get("workspace_ref"),
                supports_snapshot=d.get("supports_snapshot", True),
            )
            root["save_points"][snapshot.id] = snapshot
        return snapshot

    @staticmethod
    def _apply_scope(instance: Any, workflow_id: str, scope_dict: dict[str, Any]) -> None:
        """Upsert one execution-tree node's Scope onto an already-open `WorkflowInstance`.

        No transaction of its own: called both by `record_scope` (its own transaction, for
        standalone/test use) and by `save()` (riding along in its existing transaction --
        see the comment on `save()`'s `_pending_scopes` handling for why that's the path
        every real caller in `WorkflowService` actually uses).
        """
        if instance is None or not hasattr(instance, "scopes"):
            return
        scope_id = scope_dict["id"]
        existing = instance.scopes.get(scope_id)
        if existing is not None:
            existing.status = scope_dict.get("status", existing.status)
            if "inputs" in scope_dict:
                existing.inputs.clear()
                existing.inputs.update(scope_dict["inputs"])
                existing.entered_at = scope_dict.get("entered_at", existing.entered_at)
            if "data" in scope_dict:
                existing.data.clear()
                existing.data.update(scope_dict["data"])
            if "outputs" in scope_dict:
                existing.outputs.clear()
                existing.outputs.update(scope_dict["outputs"])
            if "completed_at" in scope_dict:
                existing.completed_at = scope_dict["completed_at"]
            existing._p_changed = True
        else:
            instance.scopes[scope_id] = Scope(
                id=scope_id,
                workflow_id=workflow_id,
                bpmn_id=scope_dict.get("bpmn_id", ""),
                bpmn_name=scope_dict.get("bpmn_name", ""),
                element_type=scope_dict.get("element_type", ""),
                parent_scope_id=scope_dict.get("parent_scope_id"),
                status=scope_dict.get("status", "active"),
                entered_at=scope_dict.get("entered_at", datetime.now(UTC).isoformat()),
                inputs=scope_dict.get("inputs", {}),
                data=scope_dict.get("data", {}),
                outputs=scope_dict.get("outputs", {}),
                completed_at=scope_dict.get("completed_at"),
            )

    @_retry_on_conflict()
    def record_scope(self, workflow_id: str, scope_dict: dict[str, Any]) -> None:
        """Upsert one execution-tree node's Scope, in its own transaction.

        `workflow_id` here is always the scope's *own* instance record (a CallActivity's
        called process gets its own Scope tree, matching how it already gets its own
        WorkflowInstance record in `_sync_children`). A missing instance is a silent no-op:
        scopes are an audit trail alongside the instance record, not a precondition for it.

        `WorkflowService` never calls this directly -- it stages scope dicts on the record
        it's already about to `save()`, so the upsert rides along in that single transaction
        instead of opening a second one concurrently with it (opening one here, on top of a
        `save()` already in flight via `to_thread`, deadlocked ZODB's commit lock against
        itself in practice). This method stays for standalone/test use.
        """
        with self.db.transaction() as connection:
            root = connection.root()
            self._apply_scope(root["workflows"].get(workflow_id), workflow_id, scope_dict)

    def list_scopes(self, workflow_id: str) -> list[dict[str, Any]]:
        with self.db.transaction() as connection:
            root = connection.root()
            instance = root["workflows"].get(workflow_id)
            if instance is None or not hasattr(instance, "scopes"):
                return []
            return [scope.to_dict() for scope in instance.scopes.values()]

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
    def save(self, workflow_id: str, record: dict[str, Any] | WorkflowInstance) -> None:  # noqa: C901, PLR0912, PLR0915 -- reconciles two input shapes (dict record vs. WorkflowInstance) against an existing-or-new instance; pre-existing complexity
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
                    existing.workspace_version = getattr(instance, "workspace_version", 0)
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
                                created_at=point.get("created_at", datetime.now(UTC).isoformat()),
                                data=point.get("data", {}),
                                tasks=point.get("tasks", []),
                                workflow=point.get("workflow"),
                                parent_workflow_id=point.get("parent_workflow_id"),
                                workspace_blob=_safe_blob_copy(point.get("workspace_blob")),
                                workspace_ref=point.get("workspace_ref"),
                                supports_snapshot=point.get("supports_snapshot", True),
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
                    or datetime.now(UTC).isoformat()
                )
                updated_at = (
                    (summaries[-1]["created_at"] if summaries else None)
                    or raw_record.get("updated_at")
                    or datetime.now(UTC).isoformat()
                )

                if existing and hasattr(existing, "events"):
                    existing_events = list(existing.events)
                    raw_events = raw_record.get("events")
                    events = raw_events or existing_events
                else:
                    events = raw_record.get("events", [])

                workspace_blob = _safe_blob_copy(
                    raw_record.get("workspace_blob") or getattr(existing, "workspace_blob", None)
                )
                workspace_archive = raw_record.get("workspace_archive") or getattr(existing, "workspace_archive", None)
                raw_workspace_version = raw_record.get("workspace_version")
                workspace_version = (
                    raw_workspace_version
                    if raw_workspace_version is not None
                    else getattr(existing, "workspace_version", 0)
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
                            if isinstance(e, (dict, PersistentMapping))
                            else (
                                getattr(e, "timestamp", None),
                                getattr(e, "event_type", None),
                                getattr(e, "task_id", None),
                            )
                            for e in instance.events
                        }
                        for e in raw_events:
                            e_dict = (
                                dict(e)
                                if isinstance(e, (dict, PersistentMapping))
                                else (e.to_dict() if hasattr(e, "to_dict") else vars(e))
                            )
                            key = (e_dict.get("timestamp"), e_dict.get("event_type"), e_dict.get("task_id"))
                            if key not in existing_events_set:
                                instance.events.append(PersistentMapping(e_dict))
                                existing_events_set.add(key)
                    instance.failure_reason = raw_record.get("failure_reason")
                    instance.failure_history = PersistentList(raw_record.get("failure_history", []))
                    instance.forked_from = raw_record.get("forked_from", instance.forked_from)
                    instance.forked_from_save_point = raw_record.get(
                        "forked_from_save_point", instance.forked_from_save_point
                    )
                    instance.parent_workflow_id = raw_record.get(
                        "parent_workflow_id", getattr(instance, "parent_workflow_id", None)
                    )
                    instance.created_at = created_at
                    instance.updated_at = updated_at
                    if workspace_blob is not None:
                        instance.workspace_blob = workspace_blob
                    if workspace_archive is not None:
                        instance.workspace_archive = workspace_archive
                    instance.workspace_version = workspace_version
                    if not hasattr(instance, "extra"):
                        instance.extra = PersistentMapping()
                    for extra_key, extra_value in raw_record.items():
                        if extra_key not in _INSTANCE_FIELDS:
                            instance.extra[extra_key] = extra_value
                    instance._p_changed = True
                else:
                    events = [PersistentMapping(e) if isinstance(e, dict) else e for e in raw_record.get("events", [])]
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
                        workspace_version=workspace_version,
                        **{k: v for k, v in raw_record.items() if k not in _INSTANCE_FIELDS},
                    )
                    workflows_root[workflow_id] = instance

            # Scope upserts staged by WorkflowService (see `WorkflowService._record_scope`)
            # ride along in this same transaction rather than opening a second one -- see
            # `record_scope`'s docstring for why that matters.
            for scope_dict in raw_record.pop("_pending_scopes", []) or []:
                self._apply_scope(instance, workflow_id, scope_dict)

            ws_meta = raw_record.get("workspace_metadata") or (
                raw_record.get("data", {}).get("workspace_metadata") if isinstance(raw_record.get("data"), dict) else {}
            )
            if not ws_meta and existing is not None:
                ws_meta = getattr(existing, "workspace_metadata", {})

            merge_st = raw_record.get("merge_status") or getattr(instance, "merge_status", None)
            merge_err = raw_record.get("merge_error") or getattr(instance, "merge_error", None)
            merge_time = raw_record.get("merged_at") or getattr(instance, "merged_at", None)

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
                metadata.merge_status = merge_st
                metadata.merge_error = merge_err
                metadata.merged_at = merge_time
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
                    merge_status=merge_st,
                    merge_error=merge_err,
                    merged_at=merge_time,
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
            workflows = root["workflows"]
            record = workflows.get(workflow_id)
            if record is None and len(workflow_id) >= 6:
                for k, v in workflows.items():
                    if k.startswith(workflow_id):
                        record = v
                        break
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
            "created_at": datetime.now(UTC).isoformat(),
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
                            created_at=sps[0].get("created_at")
                            if sps and isinstance(sps[0], dict)
                            else d.get("created_at"),
                            updated_at=sps[-1].get("created_at")
                            if sps and isinstance(sps[-1], dict)
                            else d.get("updated_at"),
                            data=d.get("data", {}),
                            failure_reason=d.get("failure_reason"),
                            parent_workflow_id=d.get("parent_workflow_id"),
                        )
                    metadata_tree[wf_id] = meta

            results = []
            for meta in metadata_tree.values():
                item = meta.to_dict() if hasattr(meta, "to_dict") else dict(meta)
                if status_filter and status_filter != "all":
                    if status_filter == "active":
                        if item.get("status") in ("completed", "cancelled"):
                            continue
                    elif item.get("status") != status_filter:
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

    def list_active(self) -> list[str]:
        """Return workflow IDs of non-terminal instances."""
        result: list[str] = []
        with self.db.transaction() as connection:
            root = connection.root()
            metadata_tree = root.get("metadata", {})
            workflows_tree = root.get("workflows", {})
            if len(metadata_tree) == 0 and len(workflows_tree) > 0:
                for wf_id, wf in workflows_tree.items():
                    status = (
                        wf.status if hasattr(wf, "status") else wf.get("status") if isinstance(wf, dict) else "unknown"
                    )
                    if status not in ("completed", "cancelled"):
                        result.append(wf_id)
            else:
                for wf_id, meta in metadata_tree.items():
                    status = (
                        meta.status
                        if hasattr(meta, "status")
                        else meta.get("status")
                        if isinstance(meta, dict)
                        else "unknown"
                    )
                    if status not in ("completed", "cancelled"):
                        result.append(wf_id)
        return result

    def list(self) -> list[tuple[str, dict[str, Any]]]:
        with self.db.transaction() as connection:
            root = connection.root()
            return [
                (wf_id, wf.to_dict() if hasattr(wf, "to_dict") else dict(wf)) for wf_id, wf in root["workflows"].items()
            ]

    @_retry_on_conflict()
    def delete(self, workflow_id: str) -> bool:
        with self.db.transaction() as connection:
            root = connection.root()
            workflows = root["workflows"]
            target_id = workflow_id
            if target_id not in workflows and len(target_id) >= 6:
                for k in list(workflows.keys()):
                    if k.startswith(target_id):
                        target_id = k
                        break
            if target_id not in workflows:
                return False
            wf = workflows[target_id]
            points = getattr(wf, "save_points", wf.get("save_points", []) if isinstance(wf, dict) else []) or []
            for p in points:
                p_id = p.get("id") if isinstance(p, dict) else getattr(p, "id", None)
                if p_id and p_id in root["save_points"]:
                    del root["save_points"][p_id]
            del workflows[target_id]
            if target_id in root["metadata"]:
                del root["metadata"][target_id]
            if target_id in root["projects"]:
                del root["projects"][target_id]
            return True

    @_retry_on_conflict()
    def clear(self) -> int:
        with self.db.transaction() as connection:
            root = connection.root()
            count = len(root["workflows"])
            root["workflows"].clear()
            root["save_points"].clear()
            root["metadata"].clear()
            root["projects"].clear()
            if "sessions" in root:
                root["sessions"].clear()
            return count

    @_retry_on_conflict()
    def reindex(self) -> dict[str, int]:
        with self.db.transaction() as connection:
            root = connection.root()
            workflows = root["workflows"]
            metadata = root["metadata"]
            metadata.clear()
            reindexed = 0
            for wid, wf in workflows.items():
                record = wf.to_dict() if hasattr(wf, "to_dict") else dict(wf)
                tasks = getattr(wf, "tasks", record.get("tasks", []))
                meta = WorkflowMetadata(
                    workflow_id=wid,
                    status=record.get("status", "unknown"),
                    process_id=record.get("process_id", "workflow"),
                    bpmn_path=record.get("bpmn_path", ""),
                    task_count=len(tasks),
                    save_point_count=len(record.get("save_points", [])),
                    parent_workflow_id=record.get("parent_workflow_id"),
                    created_at=record.get("created_at"),
                    updated_at=record.get("updated_at"),
                )
                metadata[wid] = meta
                reindexed += 1
            return {"reindexed": reindexed}

    @_retry_on_conflict()
    def purge_instances(self, status_in: Sequence[str] | None = None) -> int:
        status_filter = set(status_in or ["completed", "cancelled", "failed"])
        purged = 0
        with self.db.transaction() as connection:
            root = connection.root()
            workflows = root["workflows"]
            for wid in list(workflows.keys()):
                wf = workflows[wid]
                status = wf.get("status") if isinstance(wf, dict) else getattr(wf, "status", None)
                if status in status_filter:
                    points = getattr(wf, "save_points", wf.get("save_points", []) if isinstance(wf, dict) else []) or []
                    for p in points:
                        p_id = p.get("id") if isinstance(p, dict) else getattr(p, "id", None)
                        if p_id and p_id in root["save_points"]:
                            del root["save_points"][p_id]
                    del workflows[wid]
                    if wid in root["metadata"]:
                        del root["metadata"][wid]
                    if wid in root["projects"]:
                        del root["projects"][wid]
                    purged += 1
        return purged

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
                wf.updated_at = datetime.now(UTC).isoformat()
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
            sessions_count = len(root.get("sessions", {}))
        return {
            "storage_type": "memory" if self.path == ":memory:" else "file",
            "path": self.path,
            "size_bytes": size_bytes,
            "size_human": self._format_bytes(size_bytes),
            "instances_count": instances_count,
            "save_points_count": save_points_count,
            "sessions_count": sessions_count,
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

    def get_workspace_version(self, workflow_id: str) -> int:
        with self.db.transaction() as connection:
            root = connection.root()
            instance = root["workflows"].get(workflow_id)
            if instance is not None:
                return int(getattr(instance, "workspace_version", 0))
            return 0

    @_retry_on_conflict()
    def set_workspace(self, workflow_id: str, blob_or_bytes: Any, expected_version: int | None = None) -> None:
        with self.db.transaction() as connection:
            root = connection.root()
            instance = root["workflows"].get(workflow_id)
            if instance is not None:
                current_version = int(getattr(instance, "workspace_version", 0))
                if expected_version is not None and expected_version != current_version:
                    raise WorkspaceConflictError(
                        f"workspace for {workflow_id} was modified by another turn "
                        f"(expected version {expected_version}, found {current_version})"
                    )
                if isinstance(blob_or_bytes, bytes):
                    blob = Blob()
                    with blob.open("w") as f:
                        f.write(blob_or_bytes)
                    instance.workspace_blob = blob
                    instance.workspace_archive = None
                else:
                    instance.workspace_blob = blob_or_bytes
                    instance.workspace_archive = None
                instance.workspace_version = current_version + 1
                instance._p_changed = True
