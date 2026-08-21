from __future__ import annotations

import asyncio
import contextlib
import copy
import logging
import os
import re
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from SpiffWorkflow.bpmn.specs.mixins.events.event_types import CatchingEvent
from SpiffWorkflow.bpmn.util import BpmnEvent
from SpiffWorkflow.task import TaskState
from ZODB.blob import Blob

from app.adapters.base import AgentResult, BaseAdapter
from app.adapters.pi_adapter import PiAdapter
from app.adapters.registry import AdapterRegistry
from app.adapters.sandbox_adapter import SandboxPiAdapter
from app.engine import WorkflowRunner
from app.events import EventBus
from app.persistence import WorkflowStore, WorkspaceConflictError
from app.pi_client import PiClient, PiResult
from app.workspace import cleanup_workspace, get_workspace_metadata, pack_workspace_to_bytes, unpack_workspace
from app.ws import manager as ws_manager

logger = logging.getLogger("bpmn.workflow")

# Sentinel failure_reason for a workspace version conflict (see WorkflowStore.set_workspace).
# _complete_pi tags the job with "conflict" when it sees this message, and _dispatch's
# STARTED-task sweep skips relaunching a conflicted job -- otherwise a sibling branch's
# success re-triggers _dispatch instance-wide and silently re-runs the agent against a
# workspace it never actually agreed on, defeating the whole point of the conflict check.
# Only an explicit retry_task() call clears the flag.
WORKSPACE_CONFLICT_MESSAGE = "workspace changed during this turn; re-run against current state"

CAMUNDA_TO_FORMJS_TYPE: dict[str, str] = {
    "string": "textfield",
    "text": "textfield",
    "textarea": "textarea",
    "markdown": "text",
    "long": "number",
    "double": "number",
    "boolean": "checkbox",
    "date": "textfield",
    "enum": "select",
}


class WorkflowNotFoundError(KeyError):
    pass


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


_SEED_IGNORE = shutil.ignore_patterns(
    ".git", "node_modules", ".venv", ".devenv", ".direnv", "data", "vendor",
    "__pycache__", ".mypy_cache", ".pytest_cache", "site", "result", "*.log",
)


def _seed_workspace(workdir: str) -> None:
    """Seed a fresh instance workspace from PI_WORKDIR.

    PI_WORKDIR is a template copied in once per instance, never the directory the agent
    runs in: agents always work in their own unpacked workspace so that concurrent
    instances cannot collide and savepoints capture what the agent actually touched.
    """
    seed = os.getenv("PI_WORKDIR")
    if not seed:
        return
    seed_path = Path(seed).resolve()
    if not seed_path.is_dir():
        logger.warning("PI_WORKDIR=%s is not a directory; starting from an empty workspace", seed)
        return
    shutil.copytree(seed_path, workdir, dirs_exist_ok=True, ignore=_SEED_IGNORE, symlinks=True)
    logger.info("Seeded workspace from PI_WORKDIR=%s", seed_path)


def _sanitize(value: Any, max_length: int = 50_000, depth: int = 0, max_depth: int = 10) -> Any:
    if depth > max_depth:
        return "[nested too deep]"
    if isinstance(value, str) and len(value) > max_length:
        return value[:max_length] + "...[truncated]"
    if isinstance(value, dict):
        return {str(k): _sanitize(v, max_length, depth + 1, max_depth) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize(v, max_length, depth + 1, max_depth) for v in value]
    return value


def _sanitize_output(output: dict[str, Any] | None) -> dict[str, Any]:
    """Sanitize agent output values recursively to prevent memory bloat and unbounded data injection."""
    if not output:
        return {}
    res = _sanitize(output)
    return res if isinstance(res, dict) else {}


def _output_sources(
    result: Any,
    sanitized_output: dict[str, Any],
    failure_reason: str | None,
) -> dict[str, Any]:
    """Names a camunda:outputParameter expression may read from.

    The agent's own JSON keys (status, summary, findings, artifacts, next_action) plus
    reserved harness keys. `status` is the agent's self-reported verdict -- what a
    template means by "did the work succeed" -- falling back to the harness verdict when
    the agent produced no parseable result. `agent_status` is always the harness verdict.
    """
    sources: dict[str, Any] = dict(sanitized_output or {})
    sources.setdefault("status", result.status)
    sources.update(
        {
            "agent_status": result.status,
            "agent_text": result.text,
            "agent_output": sanitized_output,
            "agent_exit_code": result.exit_code,
            "failure_reason": failure_reason,
        }
    )
    return sources


def _contained_path(root: str, relative: str) -> Path | None:
    """Resolve `relative` under `root`, or None if it escapes.

    Artifact names come from the agent, so they are untrusted input: the orchestrator
    process (not the sandboxed agent) performs these writes.
    """
    if not relative or relative.startswith(("/", "\\")) or "\x00" in relative:
        return None
    root_resolved = Path(root).resolve()
    try:
        candidate = (root_resolved / relative).resolve()
    except (OSError, RuntimeError):
        return None
    if candidate == root_resolved or root_resolved not in candidate.parents:
        return None
    return candidate


def _process_workspace_artifacts(
    cwd: str,
    workdir: str,
    result_output: Any,
    document_content: Any,
) -> tuple[list[str], dict[str, Any]]:
    artifacts_list: list[str] = []
    if result_output and isinstance(result_output, dict):
        raw_artifacts = result_output.get("artifacts", [])
        if isinstance(raw_artifacts, list):
            for art in raw_artifacts:
                if not isinstance(art, str):
                    continue
                dst_file = _contained_path(workdir, art)
                src_file = _contained_path(cwd, art)
                if dst_file is None:
                    logger.warning("Ignoring agent artifact escaping the workspace: %r", art)
                    continue
                artifacts_list.append(art)
                if src_file is not None and src_file.is_file() and src_file != dst_file:
                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src_file, dst_file)
                elif not dst_file.is_file():
                    # The agent claimed an artifact it never wrote. Record the claim, but
                    # never invent file content from the summary and pass it off as output.
                    logger.warning("Agent declared artifact %r that does not exist in the workspace", art)

    if document_content:
        doc_file = Path(workdir) / "document.md"
        if not doc_file.exists():
            doc_file.write_text(str(document_content))
        if "document.md" not in artifacts_list:
            artifacts_list.append("document.md")

    ws_meta = get_workspace_metadata(workdir, artifacts=artifacts_list)
    return artifacts_list, ws_meta


class WorkflowService:
    def __init__(
        self,
        store: WorkflowStore,
        pi_client: Any = None,
        adapter_registry: AdapterRegistry | None = None,
    ) -> None:
        self.store = store
        self.runner = WorkflowRunner()
        self.registry = adapter_registry or AdapterRegistry()
        self.events = EventBus(store)

        if pi_client is not None:
            if isinstance(pi_client, BaseAdapter):
                self.registry.register(pi_client)
                self.registry._adapters["pi_agent"] = pi_client
            else:
                import inspect
                class GenericAdapter(BaseAdapter):
                    def __init__(self, target: Any) -> None:
                        self.target = target

                    @property
                    def adapter_type(self) -> str:
                        return "pi_agent"

                    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
                        sig = inspect.signature(self.target.run)
                        kwargs: dict[str, Any] = {}
                        if "session_id" in sig.parameters:
                            kwargs["session_id"] = config.get("session_id")
                        if "fork" in sig.parameters:
                            kwargs["fork"] = config.get("fork", "").lower() in ("true", "1", "yes")
                        try:
                            res = await self.target.run(prompt, cwd, **kwargs)
                        except TypeError:
                            res = await self.target.run(prompt, cwd)
                        if isinstance(res, AgentResult):
                            return res
                        return AgentResult(
                            status=res.status,
                            output=res.output,
                            text=res.text,
                            messages=getattr(res, "messages", []),
                            stderr=res.stderr,
                            exit_code=res.exit_code,
                            session_id=getattr(res, "session_id", None),
                        )

                self.registry.register(GenericAdapter(pi_client))
        else:
            try:
                default_timeout = float(os.getenv("PI_TIMEOUT_SECONDS", "1800"))
            except (ValueError, TypeError):
                default_timeout = 1800.0
            self.registry.register(PiAdapter(PiClient(timeout_seconds=default_timeout)))
            self.registry.register(SandboxPiAdapter(timeout_seconds=default_timeout))

        self.jobs: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._timer_task: asyncio.Task[None] | None = None

    def _lock(self, workflow_id: str) -> asyncio.Lock:
        return self._locks.setdefault(workflow_id, asyncio.Lock())

    @property
    def pi_client(self) -> Any:
        adapter = self.registry.get("pi_agent")
        if isinstance(adapter, PiAdapter):
            return adapter.client
        return adapter

    def _record(self, workflow_id: str) -> dict[str, Any]:
        record = self.store.load(workflow_id)
        if not record:
            raise WorkflowNotFoundError()
        return record

    def _public_state(self, workflow_id: str, record: dict[str, Any]) -> dict[str, Any]:
        return {
            "workflow_id": workflow_id,
            "status": record["status"],
            "process_id": record["process_id"],
            "bpmn_path": record.get("bpmn_path"),
            "data": record["data"],
            "tasks": record["tasks"],
            "jobs": record.get("jobs", {}),
            "failure_reason": record.get("failure_reason"),
            "pi_session_id": record.get("pi_session_id") or record.get("data", {}).get("pi_session_id"),
            "network": record.get("network") or record.get("data", {}).get("network"),
            "policy_error": record.get("policy_error") or record.get("data", {}).get("policy_error"),
            "save_points": [self._save_point_summary(point) for point in record.get("save_points", [])],
            "events": record.get("events", []),
            "parent_workflow_id": record.get("parent_workflow_id"),
            "forked_from": record.get("forked_from"),
            "forked_from_save_point": record.get("forked_from_save_point"),
        }

    @staticmethod
    def _save_point_summary(point: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in point.items() if key != "workflow"}

    def _add_save_point(
        self,
        workflow_id: str,
        record: dict[str, Any],
        workflow: Any,
        task: Any,
        phase: str,
        resume_action: str,
        key_suffix: str = "",
    ) -> None:
        save_points = record.setdefault("save_points", [])
        key = f"{task.id}:{phase}{key_suffix}"
        if any(point.get("key") == key for point in save_points):
            return
        # Read the live workspace from the store rather than `record` -- the record's
        # keys are rebuilt on every save by runner.record() and don't reliably carry a
        # workspace_blob (see the _sync_children comment below for the same trap). Wrap
        # the bytes in a fresh Blob so the savepoint holds an independent copy: two
        # savepoints must never share one blob, or purging one corrupts the other.
        workspace_bytes = self.store.get_workspace(workflow_id)
        workspace_blob = None
        if workspace_bytes:
            workspace_blob = Blob()
            with workspace_blob.open("w") as f:
                f.write(workspace_bytes)

        save_points.append(
            {
                "id": uuid.uuid4().hex,
                "key": key,
                "phase": phase,
                "resume_action": resume_action,
                "task_id": str(task.id),
                "task_name": getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                "status": record.get("status", "running"),
                "created_at": datetime.now(UTC).isoformat(),
                "data": dict(workflow.data),
                "tasks": self.runner.task_snapshot(workflow),
                "workflow": copy.deepcopy(workflow),
                "parent_workflow_id": record.get("parent_workflow_id"),
                "workspace_blob": workspace_blob,
            }
        )
        self._prune_save_points(record, str(task.id), phase)

    def _prune_save_points(self, record: dict[str, Any], task_id: str, phase: str) -> None:
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
                self.store.delete_save_point(save_point_id)
            except Exception as exc:
                logger.warning("Failed to delete superseded savepoint %s: %s", save_point_id, exc)
        logger.info(
            "Pruned %d superseded savepoint(s) for task %s phase %s", len(superseded), task_id, phase
        )

    @staticmethod
    def _top_workflow(workflow: Any, task: Any) -> Any:
        return getattr(getattr(task, "workflow", None), "top_workflow", None) or workflow

    def _record_session(self, workflow: Any, task: Any, session_id: str) -> None:
        """Record the agent session this task produced, on the instance-wide lineage map.

        Lives in workflow.data so that a savepoint fork inherits the lineage along with
        the workflow state. `__`-prefixed like `__children`: internal, never routable.
        """
        top = self._top_workflow(workflow, task)
        sessions = top.data.setdefault("__sessions", {})
        sessions[str(task.id)] = session_id

    def _inherited_session(self, workflow: Any, task: Any) -> str | None:
        """The session of the nearest ancestor on this task's own execution path.

        Walking the task tree rather than reading one instance-wide id means parallel
        branches inherit from their common ancestor instead of stealing whichever
        session happened to be written last.
        """
        top = self._top_workflow(workflow, task)
        sessions = top.data.get("__sessions") or {}
        if not sessions:
            return None
        node = getattr(task, "parent", None)
        seen = 0
        while node is not None and seen < 10_000:
            seen += 1
            session_id = sessions.get(str(node.id))
            if session_id:
                return str(session_id)
            parent = getattr(node, "parent", None)
            if parent is None:
                # Hop out of a subprocess to the CallActivity task that started it.
                parent_task_id = getattr(getattr(node, "workflow", None), "parent_task_id", None)
                if parent_task_id is not None:
                    try:
                        parent = top.get_task_from_id(parent_task_id)
                    except Exception:
                        parent = None
            node = parent
        return None

    def _get_root_workflow_id(self, workflow_id: str) -> str:
        record = self.store.load(workflow_id)
        if not record:
            raise WorkflowNotFoundError()
        if record.get("parent_workflow_id"):
            return self._get_root_workflow_id(record["parent_workflow_id"])
        return workflow_id

    def _sync_children(self, root_workflow_id: str, record: dict[str, Any]) -> None:
        root_workflow = record.get("workflow")
        if root_workflow is None:
            self.store.save(root_workflow_id, record)
            return

        # Must live in workflow.data, not record["data"]: runner.record() rebuilds
        # record["data"] from workflow.data on every save, so a map kept on the record
        # was silently discarded and every sync minted a fresh child record.
        children_map = root_workflow.data.setdefault("__children", {})

        def _sync(parent_id: str, parent_wf: Any) -> None:
            # One level at a time: the iterator descends into subprocesses by default,
            # which would attribute grandchildren to the root instead of their parent.
            for task in parent_wf.get_tasks(state=TaskState.ANY_MASK, skip_subprocesses=True):
                if type(task.task_spec).__name__ != "CallActivity":
                    continue
                # `task.workflow` is the workflow *containing* the call activity; the
                # subprocess it launched lives in top_workflow.subprocesses.
                child_wf = self.runner.subprocess_of(root_workflow, task)
                if child_wf is None:
                    continue

                task_id = str(task.id)
                if task_id not in children_map:
                    children_map[task_id] = uuid.uuid4().hex
                child_id = children_map[task_id]

                called = getattr(task.task_spec, "spec", "") or getattr(task.task_spec, "calledElement", "")
                bpmn_path = f"workflows/{called}.bpmn" if called else "unknown"

                child_record = self.store.load(child_id)
                if not child_record:
                    child_record = self.runner.record(
                        child_id,
                        child_wf,
                        bpmn_path,
                        called or "unknown",
                        self._status(child_wf),
                        jobs={},
                        save_points=[],
                        events=[],
                        parent_workflow_id=parent_id,
                    )
                else:
                    child_record["workflow"] = child_wf
                    child_record["status"] = self._status(child_wf)
                    child_record["tasks"] = self.runner.task_snapshot(child_wf)
                    child_record["data"] = dict(child_wf.data)
                    child_record["bpmn_path"] = bpmn_path
                    child_record["process_id"] = called or "unknown"
                    child_record["parent_workflow_id"] = parent_id

                self.store.save(child_id, child_record)
                _sync(child_id, child_wf)

        _sync(root_workflow_id, root_workflow)
        self.store.save(root_workflow_id, record)

    async def start(
        self, bpmn_path: str, process_id: str | None = None, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        variables = variables or {}
        logger.info("Starting workflow instance", extra={"bpmn_path": bpmn_path, "process_id": process_id})
        workflow_id, workflow, resolved_process_id = await asyncio.to_thread(
            self.runner.start, bpmn_path, process_id, variables
        )
        status = self._status(workflow)
        record = self.runner.record(workflow_id, workflow, bpmn_path, resolved_process_id, status, jobs={}, save_points=[], events=[])
        await asyncio.to_thread(self.store.save, workflow_id, record)
        self._sync_children(workflow_id, record)

        self.events.emit("workflow_started", workflow_id, data={"bpmn_path": bpmn_path, "process_id": process_id})
        await self._dispatch(workflow_id)
        state = self.state(workflow_id)
        await ws_manager.broadcast(workflow_id, state)
        return state

    def state(self, workflow_id: str) -> dict[str, Any]:
        record = self._record(workflow_id)
        return self._public_state(workflow_id, record)

    def instances(self) -> list[dict[str, Any]]:
        return [
            {
                "workflow_id": item["workflow_id"],
                "status": item["status"],
                "process_id": item["process_id"],
                "bpmn_path": item["bpmn_path"],
                "task_count": item["task_count"],
            }
            for item in self.store.list_metadata()
        ]

    def history_instances(
        self,
        status_filter: str | None = None,
        limit: int | None = None,
        offset: int = 0,
        since: str | None = None,
        until: str | None = None,
    ) -> list[dict[str, Any]]:
        return self.store.list_metadata(
            status_filter=status_filter,
            limit=limit,
            offset=offset,
            since=since,
            until=until,
        )

    def save_point_detail(self, workflow_id: str, save_point_id: str) -> dict[str, Any]:
        point = self.store.load_save_point(save_point_id)
        if point is not None:
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
        record = self._record(workflow_id)
        for point in record.get("save_points", []):
            if point.get("id") == save_point_id:
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
        raise KeyError(save_point_id)

    async def purge_save_points(
        self,
        workflow_id: str,
        before: str | None = None,
        before_task_id: str | None = None,
    ) -> dict[str, int]:
        """Delete every savepoint older than an anchor, releasing its workspace blob.

        Deliberately manual-only, per plans/concepts.md "Savepoint retention is a manual
        purge" -- an age/count policy can't judge which past states are still worth forking
        from, only the user can. Exactly one anchor is required: `before` (an ISO-8601
        timestamp) or `before_task_id` (resolved to the newest savepoint carrying that task,
        whose created_at becomes the cutoff). The savepoint at the cutoff itself is kept.
        """
        if bool(before) == bool(before_task_id):
            raise ValueError("purge requires exactly one of 'before' or 'before_task_id'")

        workflow_id = self._get_root_workflow_id(workflow_id)
        async with self._lock(workflow_id):
            record = self._record(workflow_id)
            points = record.get("save_points", [])

            if before_task_id is not None:
                task_points = [p for p in points if p.get("task_id") == before_task_id]
                if not task_points:
                    raise ValueError(f"no savepoints found for task {before_task_id!r}")
                cutoff = max(p["created_at"] for p in task_points)
            else:
                cutoff = before

            purge_ids = {p["id"] for p in points if p.get("created_at") < cutoff and p.get("id")}
            if purge_ids:
                record["save_points"] = [p for p in points if p.get("id") not in purge_ids]
                for save_point_id in purge_ids:
                    try:
                        self.store.delete_save_point(save_point_id)
                    except Exception as exc:
                        logger.warning("Failed to delete purged savepoint %s: %s", save_point_id, exc)
                await asyncio.to_thread(self.store.save, workflow_id, record)

            remaining = len(record.get("save_points", []))
            logger.info(
                "Purged savepoints",
                extra={"workflow_id": workflow_id, "purged": len(purge_ids), "remaining": remaining},
            )
            return {"purged": len(purge_ids), "remaining": remaining}

    async def pack_database(self, days: int = 0) -> dict[str, Any]:
        return await asyncio.to_thread(self.store.pack, days)

    async def storage_stats(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.store.storage_stats)

    async def delete_instance(self, workflow_id: str) -> bool:
        async with self._lock(workflow_id):
            for task_id, job in list(self.jobs.items()):
                if self._job_workflow(task_id, workflow_id) and not job.done():
                    job.cancel()
            deleted = self.store.delete(workflow_id)
        self._locks.pop(workflow_id, None)
        return deleted

    async def clear_instances(self) -> int:
        for job in self.jobs.values():
            if not job.done():
                job.cancel()
        count = self.store.clear()
        self._locks.clear()
        return count

    async def cancel(self, workflow_id: str) -> dict[str, Any]:
        async with self._lock(workflow_id):
            record = self._record(workflow_id)
            if record["status"] in ("completed", "cancelled"):
                return self.state(workflow_id)
            for task_id, job in list(self.jobs.items()):
                if self._job_workflow(task_id, workflow_id) and not job.done():
                    job.cancel()
            self.store.update(workflow_id, status="cancelled")
            self.events.emit("workflow_cancelled", workflow_id)
            return self.state(workflow_id)

    async def diagram(self, workflow_id: str) -> str:
        record = self._record(workflow_id)
        path = Path(record["bpmn_path"]).resolve()
        if path.suffix != ".bpmn" or not path.is_file():
            raise FileNotFoundError(path)
        return await asyncio.to_thread(path.read_text, encoding="utf-8")

    async def fork(self, workflow_id: str, save_point_id: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._lock(workflow_id):
            source = self._record(workflow_id)
            if source.get("parent_workflow_id"):
                raise ValueError(
                    f"Cannot fork child workflow '{workflow_id}' directly; fork root workflow '{source['parent_workflow_id']}' instead"
                )
            logger.info("Forking workflow from savepoint", extra={"workflow_id": workflow_id, "save_point_id": save_point_id})
            point = self.store.load_save_point(save_point_id)
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
            task = self.runner.find_task(workflow, point["task_id"])
            task.complete()
            workflow.do_engine_steps()
        fork_id = uuid.uuid4().hex
        record = self.runner.record(
            fork_id,
            workflow,
            source_bpmn_path,
            source_process_id,
            self._status(workflow),
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
        await asyncio.to_thread(self.store.save, fork_id, record)
        self._sync_children(fork_id, record)
        self.events.emit(
            "fork_created",
            fork_id,
            data={"parent_workflow_id": workflow_id, "save_point_id": save_point_id},
        )
        await self._dispatch(fork_id)
        state = self.state(fork_id)
        await ws_manager.broadcast(fork_id, state)
        return state

    async def submit_task(self, workflow_id: str, task_id: str, variables: dict[str, Any]) -> dict[str, Any]:
        workflow_id = self._get_root_workflow_id(workflow_id)
        logger.info("Submitting human user task", extra={"workflow_id": workflow_id, "task_id": task_id})
        async with self._lock(workflow_id):
            record = self._record(workflow_id)
            workflow = record["workflow"]
            task = self.runner.find_task(workflow, task_id)
            if not task.state & TaskState.READY:
                raise ValueError("task is not ready for submission")
            task.data.update(variables)
            task.workflow.data.update(variables)
            task.complete()
            workflow.do_engine_steps()
            self.events.emit(
                "human_task_submitted",
                workflow_id,
                task_id=task_id,
                task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                data=variables,
            )
            record.update(
                self.runner.record(
                    workflow_id,
                    workflow,
                    record["bpmn_path"],
                    record["process_id"],
                    self._status(workflow),
                    jobs=record.get("jobs", {}),
                )
            )
            await asyncio.to_thread(self.store.save, workflow_id, record)
            self._sync_children(workflow_id, record)
            await self._dispatch(workflow_id, _lock_held=True)
        state = self.state(workflow_id)
        if state["status"] == "completed":
            self.events.emit("workflow_completed", workflow_id, data=state["data"])
        await ws_manager.broadcast(workflow_id, state)
        return state

    async def retry_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:
        workflow_id = self._get_root_workflow_id(workflow_id)
        logger.info("Retrying failed task", extra={"workflow_id": workflow_id, "task_id": task_id})
        async with self._lock(workflow_id):
            record = self._record(workflow_id)
            workflow = record["workflow"]
            task = self.runner.find_task(workflow, task_id)
            if task.task_spec.__class__.__name__ != "ServiceTask":
                raise ValueError("only service tasks can be retried")
            if not task.state & TaskState.STARTED:
                raise ValueError("task is not failed and waiting for retry")
            job = record.setdefault("jobs", {}).get(task_id)
            if not job or job.get("status") != "failed":
                raise ValueError("task does not have a failed Pi attempt")
            job["status"] = "retry_requested"
            job["attempts"] = 0
            job["generation"] = int(job.get("generation", 0)) + 1
            job.pop("conflict", None)
            record["status"] = "retry_requested"
            self._add_save_point(
                workflow_id,
                record,
                workflow,
                task,
                "retry_requested",
                "run_harness",
                f":run_{job['generation']}",
            )
            await asyncio.to_thread(self.store.save, workflow_id, record)
            self._sync_children(workflow_id, record)
            await self._dispatch(workflow_id, _lock_held=True)
        state = self.state(workflow_id)
        await ws_manager.broadcast(workflow_id, state)
        return state

    @staticmethod
    def _catching_definitions(workflow: Any, name: str | None = None) -> list[Any]:
        definitions = []
        for task in workflow.get_tasks(state=TaskState.WAITING):
            if not isinstance(task.task_spec, CatchingEvent):
                continue
            definition = getattr(task.task_spec, "event_definition", None)
            if definition is None:
                continue
            if name is None or getattr(definition, "name", None) == name:
                definitions.append(definition)
        return definitions

    def pending_events(self, workflow_id: str) -> list[dict[str, Any]]:
        """Events this instance is currently parked on (messages, timers, signals)."""
        record = self._record(workflow_id)
        workflow = record.get("workflow")
        if workflow is None:
            return []
        return [
            {
                "name": event.name,
                "event_type": event.event_type,
                "value": str(event.value) if event.value is not None else None,
            }
            for event in workflow.waiting_events()
        ]

    async def send_message(
        self, workflow_id: str, message_name: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Deliver an external message to a waiting BPMN message catch event."""
        workflow_id = self._get_root_workflow_id(workflow_id)
        payload = dict(payload or {})
        logger.info(
            "Delivering message to workflow",
            extra={"workflow_id": workflow_id, "message_name": message_name},
        )
        async with self._lock(workflow_id):
            record = self._record(workflow_id)
            workflow = record["workflow"]
            definitions = self._catching_definitions(workflow, message_name)
            if not definitions:
                raise KeyError(f"no waiting event named {message_name!r}")

            workflow.catch(BpmnEvent(definitions[0], payload=payload))
            workflow.do_engine_steps()
            self.events.emit(
                "message_received",
                workflow_id,
                data={"message": message_name, "payload": payload},
            )
            record.update(
                self.runner.record(
                    workflow_id,
                    workflow,
                    record["bpmn_path"],
                    record["process_id"],
                    self._status(workflow),
                    jobs=record.get("jobs", {}),
                )
            )
            await asyncio.to_thread(self.store.save, workflow_id, record)
            self._sync_children(workflow_id, record)
            await self._dispatch(workflow_id, _lock_held=True)
        state = self.state(workflow_id)
        if state["status"] == "completed":
            self.events.emit("workflow_completed", workflow_id, data=state["data"])
        await ws_manager.broadcast(workflow_id, state)
        return state

    async def refresh_timers(self) -> list[str]:
        """Fire any due timer events across live instances. Returns advanced instance ids."""
        advanced: list[str] = []
        for item in self.instances():
            if item["status"] in ("completed", "cancelled", "failed"):
                continue
            workflow_id = item["workflow_id"]
            record = self.store.load(workflow_id)
            if not record or record.get("parent_workflow_id"):
                continue
            workflow = record.get("workflow")
            if workflow is None or not self._catching_definitions(workflow):
                continue

            async with self._lock(workflow_id):
                record = self._record(workflow_id)
                workflow = record["workflow"]
                before = self.runner.task_snapshot(workflow)
                workflow.refresh_timers()
                workflow.do_engine_steps()
                if self.runner.task_snapshot(workflow) == before:
                    continue
                logger.info("Timer advanced workflow", extra={"workflow_id": workflow_id})
                self.events.emit("timer_fired", workflow_id)
                record.update(
                    self.runner.record(
                        workflow_id,
                        workflow,
                        record["bpmn_path"],
                        record["process_id"],
                        self._status(workflow),
                        jobs=record.get("jobs", {}),
                    )
                )
                await asyncio.to_thread(self.store.save, workflow_id, record)
                self._sync_children(workflow_id, record)
                await self._dispatch(workflow_id, _lock_held=True)
            advanced.append(workflow_id)
            await ws_manager.broadcast(workflow_id, self.state(workflow_id))
        return advanced

    def start_timer_loop(self, interval: float | None = None) -> None:
        """Start the background ticker that fires due BPMN timer events.

        SpiffWorkflow only advances a timer when refresh_timers() is called, so
        without this loop timer events never fire at all.
        """
        if self._timer_task is not None and not self._timer_task.done():
            return
        if interval is None:
            try:
                interval = float(os.getenv("TIMER_TICK_SECONDS", "10"))
            except (TypeError, ValueError):
                interval = 10.0
        if interval <= 0:
            logger.info("Timer loop disabled (TIMER_TICK_SECONDS <= 0)")
            return
        self._timer_task = asyncio.create_task(self._timer_loop(interval))

    async def _timer_loop(self, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await self.refresh_timers()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Timer refresh failed")

    async def stop_timer_loop(self) -> None:
        task = self._timer_task
        self._timer_task = None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _dispatch(self, workflow_id: str, _lock_held: bool = False) -> None:  # noqa: PLR0915 -- scans/launches every STARTED ServiceTask for the instance in one pass; pre-existing complexity
        workflow_id = self._get_root_workflow_id(workflow_id)
        guard: Any = contextlib.nullcontext() if _lock_held else self._lock(workflow_id)
        async with guard:
            record = self._record(workflow_id)
            workflow = record["workflow"]
            jobs = record.setdefault("jobs", {})
            tasks_to_launch: list[tuple[str, str, int, int]] = []
            unresolved: list[tuple[str, str, str]] = []

            for task in self.runner.get_all_tasks(workflow, TaskState.STARTED):
                if task.task_spec.__class__.__name__ != "ServiceTask":
                    continue
                config = self.runner.pi_config(task)
                harness_type = config.get("harness_type", "pi_agent")
                if harness_type not in ("pi_agent", "mock_agent") and not self.registry.get(harness_type):
                    task_key = str(task.id)
                    task_name = getattr(task.task_spec, "bpmn_name", task.task_spec.name)
                    if jobs.get(task_key, {}).get("status") != "failed":
                        reason = (
                            f"No adapter registered for harness_type {harness_type!r} "
                            f"(registered: {', '.join(sorted(self.registry.list_types()))})"
                        )
                        previous = jobs.get(task_key, {})
                        jobs[task_key] = {
                            "status": "failed",
                            "task_name": task_name,
                            "attempts": int(previous.get("attempts", 0)),
                            "generation": int(previous.get("generation", 0)),
                            "failure_reason": reason,
                        }
                        unresolved.append((task_key, task_name, reason))
                    continue
                task_key = str(task.id)
                existing_job = jobs.get(task_key)
                if existing_job and (
                    existing_job.get("status") == "running" or existing_job.get("conflict")
                ):
                    continue
                if task_key in self.jobs and not self.jobs[task_key].done():
                    continue
                attempts = int(existing_job.get("attempts", 0)) if existing_job else 0
                attempts += 1
                generation = int(existing_job.get("generation", 0)) if existing_job else 0
                record["status"] = "waiting_pi"
                self._add_save_point(
                    workflow_id,
                    record,
                    workflow,
                    task,
                    "before_harness",
                    "run_harness",
                    f":run_{generation}:attempt_{attempts}",
                )
                task_name = getattr(task.task_spec, "bpmn_name", task.task_spec.name)
                inherited = self._inherited_session(workflow, task)
                # Continue the branch's session, but fork it whenever this turn is a
                # re-roll (retry / forked instance) or a sibling branch is already
                # running against the same session.
                session_fork = bool(inherited) and (
                    bool(record.get("forked_from"))
                    or generation > 0
                    or any(
                        other.get("status") == "running" and other.get("session_id") == inherited
                        for key, other in jobs.items()
                        if key != task_key
                    )
                )
                jobs[task_key] = {
                    "status": "running",
                    "task_name": task_name,
                    "attempts": attempts,
                    "generation": generation,
                    "session_id": inherited,
                    "session_fork": session_fork,
                }
                tasks_to_launch.append((task_key, task_name, attempts, generation))

            if tasks_to_launch or any(j.get("status") == "running" for j in jobs.values()):
                record["tasks"] = self.runner.task_snapshot(workflow)
                await asyncio.to_thread(self.store.save, workflow_id, record)
                self._sync_children(workflow_id, record)
                for task_key, task_name, attempts, generation in tasks_to_launch:
                    self.events.emit(
                        "pi_started",
                        workflow_id,
                        task_id=task_key,
                        task_name=task_name,
                        data={"attempt": attempts, "generation": generation},
                    )
                    task = asyncio.create_task(self._run_pi(workflow_id, task_key))
                    def _on_done(_t: asyncio.Task[None], k: str = task_key) -> None:
                        self.jobs.pop(k, None)
                    task.add_done_callback(_on_done)
                    self.jobs[task_key] = task
            else:
                record["status"] = self._status(workflow)
                for task in workflow.get_tasks(state=TaskState.READY):
                    if task.task_spec.__class__.__name__ == "UserTask":
                        self._add_save_point(workflow_id, record, workflow, task, "human_wait", "submit_human")
                        self.events.emit(
                            "human_task_ready",
                            workflow_id,
                            task_id=str(task.id),
                            task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                        )
                record["tasks"] = self.runner.task_snapshot(workflow)
                record["data"] = dict(workflow.data)
                await asyncio.to_thread(self.store.save, workflow_id, record)
                self._sync_children(workflow_id, record)
                if record["status"] == "completed":
                    self.events.emit("workflow_completed", workflow_id, data=record["data"])

            if unresolved:
                reason = unresolved[-1][2]
                record["failure_reason"] = reason
                record["status"] = "failed"
                record["tasks"] = self.runner.task_snapshot(workflow)
                await asyncio.to_thread(self.store.save, workflow_id, record)
                for task_key, task_name, task_reason in unresolved:
                    logger.error("Unresolvable harness for task %s: %s", task_key, task_reason)
                    self.events.emit(
                        "pi_failed",
                        workflow_id,
                        task_id=task_key,
                        task_name=task_name,
                        data={"failure_reason": task_reason},
                    )
                self.events.emit("workflow_failed", workflow_id, data={"failure_reason": reason})

    def jobs_for_workflow(self, workflow_id: str) -> list[asyncio.Task[None]]:
        return [job for task_id, job in self.jobs.items() if not job.done() and self._job_workflow(task_id, workflow_id)]

    def _job_workflow(self, task_id: str, workflow_id: str) -> bool:
        record = self.store.load(workflow_id)
        return bool(record and task_id in record.get("jobs", {}))

    async def _run_pi(self, workflow_id: str, task_id: str) -> None:
        workflow_id = self._get_root_workflow_id(workflow_id)
        workdir = None
        ws_meta: dict[str, Any] | None = None
        try:
            record = self._record(workflow_id)
            task = self.runner.find_task(record["workflow"], task_id)
            config = self.runner.pi_config(task)

            job_entry = record.get("jobs", {}).get(task_id, {})
            session_id = job_entry.get("session_id")
            if session_id:
                config["session_id"] = str(session_id)
                if "fork" not in config:
                    config["fork"] = "true" if job_entry.get("session_fork") else "false"

            harness_type = config.get("harness_type", "pi_agent")

            adapter = self.registry.get(harness_type) or self.registry.get("pi_agent")
            if not adapter:
                raise ValueError(f"No adapter registered for harness_type: {harness_type}")

            # Unpack per-instance workspace archive (TODO 05)
            blob_or_bytes = self.store.get_workspace(workflow_id)
            workspace_version = self.store.get_workspace_version(workflow_id)
            workdir = await unpack_workspace(blob_or_bytes, prefix=f"bpmn-{workflow_id[:8]}-")
            if not blob_or_bytes:
                await asyncio.to_thread(_seed_workspace, workdir)
            cwd = workdir

            # Harness-specific workspace setup is the adapter's business, not ours
            await adapter.prepare_workspace(cwd, config)

            prompt = self.runner.prompt(workflow_id, task, record["workflow"])

            async def _on_event(ev: dict[str, Any]) -> None:
                try:
                    from app.ws import manager
                    await manager.broadcast(workflow_id, {
                        "type": "pi_event",
                        "workflow_id": workflow_id,
                        "task_id": task_id,
                        "task_name": getattr(task, "name", task_id),
                        "event": ev,
                    })
                except Exception:
                    pass

            result = await adapter.run(prompt, config, cwd, on_event=_on_event)

            # Capture generated artifacts and documents into the isolated instance workspace
            wf_data = record["workflow"].data
            _artifacts_list, ws_meta = await asyncio.to_thread(
                _process_workspace_artifacts,
                cwd,
                workdir,
                result.output,
                wf_data.get("document_content"),
            )
            record["workspace_metadata"] = ws_meta

            # Repack modified workspace back into storage. This is an interim
            # optimistic-concurrency guard, not the real fix: concurrent turns on the same
            # instance still share one workspace and cannot merge their changes. The real
            # fix is a workspace per branch (git worktree model), not yet designed -- see
            # plans/data.md "Not a backlog item: the worktree model". Until then, refuse to
            # silently overwrite a workspace another concurrent turn has already moved on
            # from; expected_version turns that into a loud, retryable failure instead.
            if workdir and Path(workdir).exists():
                archive_bytes = await pack_workspace_to_bytes(workdir)
                self.store.set_workspace(workflow_id, archive_bytes, expected_version=workspace_version)
        except asyncio.CancelledError:
            logger.info(f"Agent task {task_id} was cancelled")
            result = AgentResult("cancelled", None, "", [], "Task was cancelled", 1)
        except WorkspaceConflictError:
            logger.warning(
                "Workspace conflict repacking task %s on %s; another turn already wrote a newer workspace",
                task_id,
                workflow_id,
            )
            result = AgentResult("failed", None, "", [], WORKSPACE_CONFLICT_MESSAGE, 1)
        except Exception as exc:
            logger.exception(f"Error running agent task {task_id}: {exc}")
            result = AgentResult("failed", None, "", [], str(exc), 1)
        finally:
            if workdir:
                cleanup_workspace(workdir)

        await self._complete_pi(workflow_id, task_id, result, workspace_metadata=ws_meta)

    async def _complete_pi(  # noqa: C901, PLR0912, PLR0915 -- reconciles one agent-turn result into job/task/record/event state across every outcome (success/cancelled/failed); pre-existing complexity
        self,
        workflow_id: str,
        task_id: str,
        result: AgentResult | PiResult,
        workspace_metadata: dict[str, Any] | None = None,
    ) -> None:
        workflow_id = self._get_root_workflow_id(workflow_id)
        async with self._lock(workflow_id):
            record = self._record(workflow_id)
            workflow = record["workflow"]
            task = self.runner.find_task(workflow, task_id)
            job = record.setdefault("jobs", {}).setdefault(task_id, {})
            if job.get("status") != "running":
                return

            if workspace_metadata:
                record["workspace_metadata"] = workspace_metadata

            net_data = getattr(result, "network", None)
            if net_data:
                record["network"] = net_data
                task.data["network"] = net_data
                try:
                    from app.ws import manager
                    await manager.broadcast(workflow_id, {
                        "type": "network_summary",
                        "workflow_id": workflow_id,
                        "task_id": task_id,
                        "network": net_data,
                    })
                except Exception:
                    pass

            policy_err = getattr(result, "policy_error", None)
            if policy_err:
                record["policy_error"] = policy_err
                task.data["policy_error"] = policy_err

            failure_reason = None
            if result.status != "success":
                failure_reason = result.stderr.strip()
                if not failure_reason and result.exit_code not in (None, 0):
                    failure_reason = f"Pi exited with code {result.exit_code}"
                elif not failure_reason and not result.text:
                    failure_reason = (
                        "Pi exited successfully without producing an assistant result. "
                        "This usually means no authenticated provider/model is configured; "
                        "check OpenCode Zen credentials, OPENAI_API_KEY, OPENAI_BASE_URL, and PI_MODEL."
                    )
                elif not failure_reason:
                    failure_reason = "Pi returned text that did not match the required JSON result schema"

            job.update({"status": result.status, "exit_code": result.exit_code, "stderr": result.stderr[-4000:]})
            if failure_reason:
                job["failure_reason"] = failure_reason
                record["failure_reason"] = failure_reason
                job["conflict"] = failure_reason == WORKSPACE_CONFLICT_MESSAGE
                record.setdefault("failure_history", []).append(
                    {
                        "task_id": task_id,
                        "attempt": job.get("attempts", 1),
                        "reason": failure_reason,
                    }
                )

            sanitized_output = _sanitize_output(result.output)
            sources = _output_sources(result, sanitized_output, failure_reason)

            # Task-local scope. Agent results never reach workflow.data implicitly: a
            # service task publishes to the workflow only through camunda:outputParameters,
            # so parallel agent turns cannot overwrite each other's verdict.
            task.data.update(
                {
                    "agent_status": result.status,
                    "status": sources["status"],
                    "agent_output": sanitized_output,
                    "agent_text": result.text,
                }
            )

            extensions = getattr(task.task_spec, "extensions", {}) or {}
            output_params = extensions.get("outputParameters", {})
            published: dict[str, Any] = {}
            for target_var, source_expr in output_params.items():
                source_key = (
                    source_expr[2:-1]
                    if source_expr.startswith("${") and source_expr.endswith("}")
                    else source_expr
                )
                # Only actionable when the agent actually produced a result: on a failed
                # or cancelled turn every agent-JSON key is legitimately absent.
                if source_key not in sources and sanitized_output:
                    logger.warning(
                        "Task %s maps outputParameter %r from unknown key %r; publishing None",
                        task_id,
                        target_var,
                        source_key,
                    )
                published[target_var] = sources.get(source_key)
            if published:
                # task.data is inherited by successor tasks, so this is the scope BPMN
                # gateway conditions evaluate in -- and it is per-branch, which is what
                # makes parallel agent turns safe. workflow.data additionally carries the
                # instance-wide view surfaced in the API and UI.
                task.data.update(published)
                task.workflow.data.update(published)

            if failure_reason:
                task.data["failure_reason"] = failure_reason

            if result.status == "success" and getattr(result, "session_id", None):
                record["pi_session_id"] = result.session_id
                record.setdefault("data", {})["pi_session_id"] = result.session_id
                task.data["pi_session_id"] = result.session_id
                self._record_session(workflow, task, str(result.session_id))

            attempt = job.get("attempts", 1)
            generation = job.get("generation", 0)
            self._add_save_point(
                workflow_id,
                record,
                workflow,
                task,
                "after_harness",
                "complete_harness",
                f":run_{generation}:attempt_{attempt}",
            )

            if result.status == "success":
                record.pop("failure_reason", None)
                task.workflow.data.pop("failure_reason", None)
                job["status"] = "success"
                job.pop("failure_reason", None)
                task.complete()
                workflow.do_engine_steps()
                self.events.emit(
                    "pi_completed",
                    workflow_id,
                    task_id=task_id,
                    task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                    data=sanitized_output,
                )
            elif result.status == "cancelled":
                job["status"] = "cancelled"
                job["failure_reason"] = failure_reason
                self.events.emit(
                    "pi_cancelled",
                    workflow_id,
                    task_id=task_id,
                    task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                    data={"failure_reason": failure_reason},
                )
            else:
                self.events.emit(
                    "pi_failed",
                    workflow_id,
                    task_id=task_id,
                    task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                    data={"failure_reason": failure_reason, "exit_code": result.exit_code},
                )

            status = self._status(workflow) if result.status == "success" else ("cancelled" if result.status == "cancelled" else "failed")
            if status == "failed":
                self.events.emit(
                    "workflow_failed",
                    workflow_id,
                    data={"failure_reason": failure_reason},
                )
            elif status == "cancelled":
                self.events.emit(
                    "workflow_cancelled",
                    workflow_id,
                    data={"failure_reason": failure_reason},
                )
            record.update(
                self.runner.record(
                    workflow_id,
                    workflow,
                    record["bpmn_path"],
                    record["process_id"],
                    status,
                    jobs=record["jobs"],
                )
            )
            await asyncio.to_thread(self.store.save, workflow_id, record)
            self._sync_children(workflow_id, record)
            state = self.state(workflow_id)
            await ws_manager.broadcast(workflow_id, state)

        if result.status == "success":
            await self._dispatch(workflow_id)

    @staticmethod
    def _status(workflow: Any) -> str:
        if workflow.is_completed():
            return "completed"
        for task in workflow.get_tasks(state=TaskState.READY):
            if task.task_spec.__class__.__name__ == "UserTask":
                return "waiting_human"
        if any(
            isinstance(task.task_spec, CatchingEvent)
            for task in workflow.get_tasks(state=TaskState.WAITING)
        ):
            return "waiting_event"
        return "running"

    def form(self, workflow_id: str, task_id: str) -> dict[str, Any]:
        record = self._record(workflow_id)
        task = self.runner.find_task(record["workflow"], task_id)
        if task.task_spec.__class__.__name__ != "UserTask":
            raise ValueError("task is not a user task")
        extensions = getattr(task.task_spec, "extensions", {}) or {}
        form_data = extensions.get("form", {}) if isinstance(extensions, dict) else {}
        fields = form_data.get("fields", [])
        components = []
        for field in fields:
            raw_type = field.get("type", "string")
            formjs_type = CAMUNDA_TO_FORMJS_TYPE.get(raw_type, "textfield")
            component: dict[str, Any] = {
                "id": field.get("id"),
                "key": field.get("id"),
                "type": formjs_type,
            }
            if formjs_type == "text":
                component["text"] = field.get("defaultValue") or field.get("label", "")
            else:
                component["label"] = field.get("label", field.get("id"))
                if field.get("defaultValue"):
                    component["defaultValue"] = field.get("defaultValue")

            if formjs_type == "select" and "values" in field:
                component["values"] = [
                    {"label": v.get("name", v.get("id")), "value": v.get("id")}
                    for v in field["values"]
                ]
            if formjs_type == "number":
                component["validate"] = {"required": False}
            components.append(component)

        return {
            "schemaVersion": 11,
            "exporter": {"name": "bpmn-ai-starter", "version": "1.0"},
            "type": "default",
            "id": f"Form_{task_id}",
            "components": components,
            "fields": fields,
        }

    async def recover_orphaned_workflows(self) -> int:
        """Scan for orphaned workflows in 'waiting_pi' with no active jobs and mark them failed."""
        recovered = 0
        for item in self.instances():
            if item["status"] == "waiting_pi":
                record = self.store.load(item["workflow_id"])
                if not record:
                    continue
                jobs = record.get("jobs", {})
                active_job = any(job_id in self.jobs and not self.jobs[job_id].done() for job_id in jobs)
                if not active_job:
                    logger.warning(f"Recovering orphaned workflow: {item['workflow_id']}")
                    record["status"] = "failed"
                    record["failure_reason"] = "Recovered orphaned workflow on system startup"
                    for j in record.get("jobs", {}).values():
                        if j.get("status") == "running":
                            j["status"] = "failed"
                            j["failure_reason"] = "Process terminated unexpectedly"
                    await asyncio.to_thread(self.store.save, item["workflow_id"], record)
                    recovered += 1
        return recovered
