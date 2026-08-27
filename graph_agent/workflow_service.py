from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import os
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from SpiffWorkflow.bpmn.specs.mixins.events.event_types import CatchingEvent
from SpiffWorkflow.bpmn.util import BpmnEvent
from SpiffWorkflow.task import TaskState

from graph_agent.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter
from graph_agent.adapters.pi_adapter import PiAdapter
from graph_agent.adapters.registry import AdapterRegistry
from graph_agent.agents_root import Workspace
from graph_agent.engine import WorkflowRunner, resolve_output_mapping
from graph_agent.events import EventBus
from graph_agent.orchestration import children, jobs, savepoints
from graph_agent.orchestration import fork as fork_module
from graph_agent.orchestration.jobs import (
    WORKSPACE_CONFLICT_MESSAGE,  # noqa: F401 -- re-exported for tests/test_workspace_concurrency.py
)
from graph_agent.persistence import WorkflowStore
from graph_agent.pi_client import PiClient, PiResult
from graph_agent.ws import manager as ws_manager

logger = logging.getLogger("bpmn.workflow")

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


class WorkflowService:
    """Orchestration façade: BPMN engine steps, persistence, and the agent-turn lifecycle.

    The implementation is split by concern across `graph_agent/orchestration/`:
    - `savepoints.py` -- recording, reading, and purging durable checkpoints
    - `fork.py` -- branching a new instance from a past savepoint
    - `jobs.py` -- the agent-turn job loop (dispatch / run / complete)
    - `children.py` -- mirroring CallActivity / event-subprocess children into the store

    Methods below that just call into those modules exist so external code and tests can
    keep calling `service.<name>(...)` (including private names some tests reach into
    directly, and one that gets monkeypatched) without knowing which file owns the body.
    """

    def __init__(
        self,
        store: WorkflowStore,
        pi_client: Any = None,
        adapter_registry: AdapterRegistry | None = None,
        workspace: Workspace | None = None,
    ) -> None:
        self.store = store
        # None (the default -- every existing caller that hasn't opted in, including this
        # whole test suite) means turns always run against BlobStrategy's ephemeral
        # scratch directories, exactly as before. Only a caller that explicitly hands
        # this service a real Workspace (create_app(), for a genuine `bpmn serve`) gets
        # worktree-by-default -- see workspace_strategy.select_strategy's docstring for
        # why guessing one from the current directory here would be wrong.
        self.workspace = workspace
        self.runner = WorkflowRunner()
        self.registry = adapter_registry or AdapterRegistry()
        from graph_agent.adapters.graph_extend_adapter import GraphExtendAdapter

        self.registry.register(GraphExtendAdapter(self))
        self.events = EventBus(store)

        if pi_client is not None:
            if isinstance(pi_client, BaseAdapter):
                self.registry.register(pi_client)
                self.registry.bind("pi_agent", pi_client)
            else:

                class GenericAdapter(BaseAdapter):
                    def __init__(self, target: Any) -> None:
                        self.target = target

                    @property
                    def adapter_type(self) -> str:
                        return "pi_agent"

                    @property
                    def capabilities(self) -> AdapterCapabilities:
                        # Wraps a Pi-shaped client, so it is an agent: it must opt into
                        # session threading or every turn starts a fresh context.
                        return AdapterCapabilities(display_name="Pi Agent", supports_sessions=True)

                    async def run(
                        self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None
                    ) -> AgentResult:
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
        elif adapter_registry is None:
            try:
                default_timeout = float(os.getenv("PI_TIMEOUT_SECONDS", "1800"))
            except (ValueError, TypeError):
                default_timeout = 1800.0
            self.registry.register(PiAdapter(PiClient(timeout_seconds=default_timeout)))

        self.jobs: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._timer_task: asyncio.Task[None] | None = None
        # Clamped to >= 1: asyncio.Semaphore(0) never grants a permit, so
        # MAX_PARALLEL_TURNS=0 would silently deadlock every agent turn forever, and a
        # negative value raises ValueError out of the Semaphore constructor, crashing
        # this whole __init__. Either way this must fail safe, not fail total.
        try:
            self.max_parallel_turns = max(1, int(os.getenv("MAX_PARALLEL_TURNS", "4")))
        except (ValueError, TypeError):
            self.max_parallel_turns = 4
        self._turn_semaphore = asyncio.Semaphore(self.max_parallel_turns)

    def _lock(self, workflow_id: str) -> asyncio.Lock:
        return self._locks.setdefault(workflow_id, asyncio.Lock())

    def _capabilities(self, task: Any) -> AdapterCapabilities:
        return jobs.capabilities(self, task)

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
            "workspace_metadata": record.get("workspace_metadata") or record.get("data", {}).get("workspace_metadata"),
            "save_points": [self._save_point_summary(point) for point in record.get("save_points", [])],
            "events": record.get("events", []),
            "parent_workflow_id": record.get("parent_workflow_id"),
            "forked_from": record.get("forked_from"),
            "forked_from_save_point": record.get("forked_from_save_point"),
            "merge_status": record.get("merge_status"),
            "merge_error": record.get("merge_error"),
            "merged_at": record.get("merged_at"),
        }

    @staticmethod
    def _save_point_summary(point: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in point.items() if key != "workflow"}

    async def _add_save_point(
        self,
        workflow_id: str,
        record: dict[str, Any],
        workflow: Any,
        task: Any,
        phase: str,
        resume_action: str,
        key_suffix: str = "",
    ) -> None:
        await savepoints.add_save_point(self, workflow_id, record, workflow, task, phase, resume_action, key_suffix)

    @staticmethod
    def _parent_scope_id(task: Any) -> str | None:
        wf = getattr(task, "workflow", None)
        top = getattr(wf, "top_workflow", None)
        if wf is not None and top is not None and wf is not top:
            parent_task_id = getattr(wf, "parent_task_id", None)
            if parent_task_id is not None:
                return str(parent_task_id)
        return None

    def _record_scope(
        self,
        record: dict[str, Any],
        task: Any,
        element_type: str,
        *,
        status: str,
        inputs: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        outputs: dict[str, Any] | None = None,
        completed: bool = False,
    ) -> None:
        """Stage one execution-tree node's Scope upsert onto `record` -- see
        docs/variable-scoping-plan.md.

        Always staged against the *root* instance's scope tree, even for a task inside a
        called/nested process: `_parent_scope_id` expresses the tree shape without needing a
        separate scopes collection per child WorkflowInstance record (which would need
        reconstructing the same launching-task lookup `_sync_children` already does, for no
        query benefit -- "every scope for this root instance" stays a single lookup).

        Deliberately *not* a direct `self.store.record_scope()` call: every caller here is
        about to `self.store.save(workflow_id, record)` anyway, and `save()` applies
        `record["_pending_scopes"]` inside that same transaction. Writing the scope in a
        second, separate transaction -- especially one opened synchronously on the event-loop
        thread, or even via its own `to_thread` call -- raced against the `save()` transaction
        already in flight for the same instance and reliably deadlocked or hung ZODB's commit
        path in practice; riding along in the existing transaction sidesteps that entirely.
        """
        now = datetime.now(UTC).isoformat()
        scope_dict: dict[str, Any] = {
            "id": str(task.id),
            "bpmn_id": getattr(task.task_spec, "bpmn_id", task.task_spec.name),
            "bpmn_name": getattr(task.task_spec, "bpmn_name", task.task_spec.name),
            "element_type": element_type,
            "parent_scope_id": self._parent_scope_id(task),
            "status": status,
        }
        if inputs is not None:
            scope_dict["inputs"] = inputs
            scope_dict["entered_at"] = now
        if data is not None:
            scope_dict["data"] = data
        if outputs is not None:
            scope_dict["outputs"] = outputs
        if completed:
            scope_dict["completed_at"] = now
        record.setdefault("_pending_scopes", []).append(scope_dict)

    @staticmethod
    def _top_workflow(workflow: Any, task: Any) -> Any:
        return getattr(getattr(task, "workflow", None), "top_workflow", None) or workflow

    def _record_session(
        self,
        workflow: Any,
        task: Any,
        session_id: str,
        harness_type: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        """Record the agent session this task produced, on the instance-wide lineage map and in ZODB.

        Lives in workflow.data so that a savepoint fork inherits the lineage along with
        the workflow state. Also persisted into ZODB root['sessions'] for persistent session tracking.
        """
        top = self._top_workflow(workflow, task)
        sessions = top.data.setdefault("__sessions", {})
        sessions[str(task.id)] = session_id
        workflow_id = getattr(top, "workflow_id", None) or getattr(workflow, "workflow_id", "")
        inherited = self._inherited_session(workflow, task)
        try:
            self.store.save_session(
                session_id=session_id,
                data_or_record={
                    "session_id": session_id,
                    "workflow_id": workflow_id,
                    "task_id": str(task.id),
                    "harness_type": harness_type or getattr(task, "harness_type", None) or "pi_agent",
                    "parent_session_id": inherited if inherited != session_id else None,
                    "data": data or {},
                },
            )
        except Exception as exc:
            logger.warning("Failed to persist session %s in ZODB: %s", session_id, exc)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        return self.store.get_session(session_id)

    def list_sessions(self, workflow_id: str | None = None) -> list[dict[str, Any]]:
        return self.store.list_sessions(workflow_id)

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
        children.sync_children(self, root_workflow_id, record)

    async def start(
        self, bpmn_path: str, process_id: str | None = None, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        variables = variables or {}
        logger.info("Starting workflow instance", extra={"bpmn_path": bpmn_path, "process_id": process_id})
        workflow_id, workflow, resolved_process_id = await asyncio.to_thread(
            self.runner.start, bpmn_path, process_id, variables
        )
        status = self._status(workflow)
        record = self.runner.record(
            workflow_id, workflow, bpmn_path, resolved_process_id, status, jobs={}, save_points=[], events=[]
        )
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
        return savepoints.save_point_detail(self, workflow_id, save_point_id)

    async def purge_save_points(
        self,
        workflow_id: str,
        before: str | None = None,
        before_task_id: str | None = None,
    ) -> dict[str, int]:
        return await savepoints.purge_save_points(self, workflow_id, before=before, before_task_id=before_task_id)

    def register_webhook(self, url: str, events: list[str] | None = None) -> dict[str, Any]:
        return self.store.register_webhook(url, events)

    def list_webhooks(self) -> list[dict[str, Any]]:
        return self.store.list_webhooks()

    def delete_webhook(self, webhook_id: str) -> bool:
        return self.store.delete_webhook(webhook_id)

    def get_events(self, workflow_id: str) -> list[dict[str, Any]]:
        return self.store.get_events(workflow_id)

    def get_workspace(self, workflow_id: str) -> Any | None:
        return self.store.get_workspace(workflow_id)

    def get_workspace_metadata(self, workflow_id: str) -> dict[str, Any]:
        return self.store.get_workspace_metadata(workflow_id)

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

    async def reindex(self) -> dict[str, int]:
        return await asyncio.to_thread(self.store.reindex)

    async def purge_instances(self, statuses: Sequence[str] | None = None) -> int:
        return await asyncio.to_thread(self.store.purge_instances, statuses)

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

    def get_spec_xml(self, workflow_id: str) -> str:
        """Return the BPMN XML of a workflow instance's current spec."""
        record = self._record(workflow_id)
        workflow = record.get("workflow")
        if workflow is None:
            bpmn_path = record.get("bpmn_path")
            if bpmn_path and Path(bpmn_path).exists():
                return Path(bpmn_path).read_text(encoding="utf-8")
            raise ValueError("No BPMN XML available for this workflow instance")
        return self.runner.extract_bpmn_xml(workflow)

    async def _replace_spec_unlocked(
        self, workflow_id: str, new_xml: str, *, allow_mid_execution: bool = False
    ) -> dict[str, Any]:
        record = self._record(workflow_id)
        status = record.get("status")
        if not allow_mid_execution and status in ("running", "waiting_pi", "retry_requested"):
            raise ValueError("Workflow is mid-execution (running agent turn); wait for completion")

        from graph_agent.bpmn_utils import replace_spec as do_replace

        workflow = record.get("workflow")
        if workflow is None:
            raise ValueError("Workflow object not available for this instance")

        workflow, warnings = do_replace(workflow, new_xml)

        # Save with updated spec
        record["workflow"] = workflow
        record["tasks"] = self.runner.task_snapshot(workflow)
        record["status"] = self._status(workflow)

        # Create a savepoint at the migration point
        await self._add_save_point(
            workflow_id,
            record,
            workflow,
            task=None,
            phase="spec_replaced",
            resume_action="continue",
        )
        await asyncio.to_thread(self.store.save, workflow_id, record)

        self.events.emit(
            "spec_replaced",
            workflow_id,
            data={"warnings": warnings},
        )

        return {
            "workflow_id": workflow_id,
            "status": record.get("status", "unknown"),
            "warnings": warnings,
        }

    async def replace_spec(
        self, workflow_id: str, new_xml: str, *, allow_mid_execution: bool = False
    ) -> dict[str, Any]:
        """Replace a workflow's BPMN spec with new XML.

        Must be called when the workflow is in a stable state
        (waiting_human, waiting_event, completed, failed).
        Cannot be called while an agent turn is in progress.
        """
        async with self._lock(workflow_id):
            return await self._replace_spec_unlocked(workflow_id, new_xml, allow_mid_execution=allow_mid_execution)

    async def validate_spec_replacement(self, workflow_id: str, new_xml: str) -> dict[str, Any]:
        """Dry-run validation: check migration feasibility without applying changes."""
        record = self._record(workflow_id)
        from SpiffWorkflow.task import TaskState

        from graph_agent.bpmn_utils import validate_bpmn

        val_result = validate_bpmn(new_xml)
        if not val_result.valid:
            return {
                "valid": False,
                "errors": val_result.errors,
                "warnings": val_result.warnings,
                "migrated_tasks": [],
                "new_tasks": [],
                "removed_tasks": [],
            }

        workflow = record.get("workflow")
        if workflow is None:
            return {
                "valid": False,
                "errors": ["Workflow object not available for this instance"],
                "warnings": [],
                "migrated_tasks": [],
                "new_tasks": [],
                "removed_tasks": [],
            }

        new_task_ids = set(val_result.task_ids)
        current_tasks = [
            t for t in workflow.get_tasks() if t.state not in (TaskState.FUTURE, TaskState.MAYBE, TaskState.LIKELY)
        ]
        migrated_tasks: list[str] = []
        removed_tasks: list[str] = []
        warnings = list(val_result.warnings)
        errors: list[str] = []

        for t in current_tasks:
            bpmn_id = getattr(t.task_spec, "bpmn_id", None) or t.task_spec.name
            if bpmn_id in new_task_ids or t.task_spec.name in new_task_ids:
                if bpmn_id not in migrated_tasks:
                    migrated_tasks.append(bpmn_id)
            elif t.state in (TaskState.COMPLETED, TaskState.CANCELLED):
                removed_tasks.append(bpmn_id)
                warnings.append(f"Completed task '{bpmn_id}' not in new spec (history only)")
            else:
                errors.append(
                    f"Active task '{bpmn_id}' (state={TaskState.get_name(t.state)}) not found in new BPMN spec"
                )

        new_tasks = [
            tid
            for tid in val_result.task_ids
            if tid not in migrated_tasks and tid not in ("Start", "End", "Root") and not tid.endswith(".EndJoin")
        ]

        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "migrated_tasks": migrated_tasks,
            "new_tasks": new_tasks,
            "removed_tasks": removed_tasks,
        }

    async def extend_graph(
        self, workflow_id: str, request: Any, *, allow_mid_execution: bool = False
    ) -> dict[str, Any]:
        """Insert nodes into a running workflow's graph and apply the change.

        Combines insert_nodes() + replace_spec() in one atomic operation.
        """
        async with self._lock(workflow_id):
            # 1. Get current spec XML
            current_xml = self.get_spec_xml(workflow_id)

            # 2. Build InsertionSpec from request
            from graph_agent.bpmn_utils import BpmnNode, InsertionSpec, insert_nodes

            nodes_list = getattr(request, "nodes", [])
            after_target = getattr(request, "after", "")
            after_flow = getattr(request, "after_flow", None)

            insertion = InsertionSpec(
                after=after_target,
                nodes=[
                    BpmnNode(
                        bpmn_id=n.bpmn_id,
                        name=n.name,
                        element_type=n.element_type,
                        properties=n.properties,
                        input_params=n.input_params,
                        output_params=n.output_params,
                        form_fields=n.form_fields,
                    )
                    for n in nodes_list
                ],
                after_flow=after_flow,
            )

            # 3. Insert nodes into XML
            new_xml = insert_nodes(current_xml, insertion)

            # 4. Apply spec replacement
            result = await self._replace_spec_unlocked(workflow_id, new_xml, allow_mid_execution=allow_mid_execution)
            result["inserted_nodes"] = [n.bpmn_id for n in nodes_list]
            result["spec_xml"] = new_xml
            return result

    async def diagram(self, workflow_id: str) -> str:
        record = self._record(workflow_id)
        path = Path(record["bpmn_path"]).resolve()
        if path.suffix != ".bpmn" or not path.is_file():
            raise FileNotFoundError(path)
        return await asyncio.to_thread(path.read_text, encoding="utf-8")

    async def fork(
        self, workflow_id: str, save_point_id: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return await fork_module.fork(self, workflow_id, save_point_id, variables)

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
            extensions = getattr(task.task_spec, "extensions", {}) or {}
            output_params = extensions.get("outputParameters", {})
            if output_params:
                published = resolve_output_mapping(output_params, dict(variables))
            else:
                # No explicit outputParameters: the declared form fields are this UserTask's
                # own mapping -- only a submitted variable the task itself asked for crosses
                # into the outer scope. See docs/variable-scoping-plan.md.
                form_fields = (
                    extensions.get("form", {}).get("fields", []) if isinstance(extensions.get("form"), dict) else []
                )
                declared_names = {f.get("id") for f in form_fields if f.get("id")}
                published = {k: v for k, v in variables.items() if k in declared_names}
            task.workflow.data.update(published)
            self._record_scope(
                record, task, "UserTask", status="completed", data=dict(task.data), outputs=published, completed=True
            )
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
                raise ValueError("task does not have a failed harness attempt")
            job["status"] = "retry_requested"
            job["attempts"] = 0
            job["generation"] = int(job.get("generation", 0)) + 1
            job.pop("conflict", None)
            record["status"] = "retry_requested"
            await self._add_save_point(
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

        # An event subprocess's start event is never a WAITING task in the tree -- it is
        # perpetually armed to spawn a new subprocess instance, tracked on
        # workflow.spec.start.trigger_specs instead. Without this, send_message() can never
        # deliver the message that spawns the *first* child (there is nothing "waiting" yet),
        # and workflow.waiting_events() doesn't list it either.
        for spec_name in getattr(workflow.spec.start, "trigger_specs", []):
            sp_spec = workflow.subprocess_specs.get(spec_name)
            if sp_spec is None:
                continue
            for start_task_spec in getattr(sp_spec, "bpmn_start_events", []):
                definition = getattr(start_task_spec, "event_definition", None)
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

            # The task actually catching this message, if it's an existing WAITING task
            # rather than a fresh event-subprocess spawn -- captured before catch() runs so
            # its containing (sub)workflow is known regardless of nesting.
            catching_task = next(
                (
                    task
                    for task in workflow.get_tasks(state=TaskState.WAITING)
                    if isinstance(task.task_spec, CatchingEvent)
                    and getattr(getattr(task.task_spec, "event_definition", None), "name", None) == message_name
                ),
                None,
            )

            existing_subprocess_ids = set(workflow.subprocesses.keys())
            workflow.catch(BpmnEvent(definitions[0], payload=payload))
            spawned_ids = set(workflow.subprocesses.keys()) - existing_subprocess_ids
            # A message matching an event-subprocess trigger spawns a brand new subprocess
            # whose own workflow.data starts empty: BpmnEvent.payload only lands on the
            # triggering task's *task* data, which runner.prompt() (and thus the child's own
            # agent turns) never reads -- only the subprocess's own workflow.data is. Without
            # this, the payload stays invisible to the child until it completes, at which
            # point SpiffWorkflow's terminal-task data merge finally surfaces it externally.
            for spawned_id in spawned_ids:
                workflow.subprocesses[spawned_id].data.update(payload)
            if not spawned_ids and catching_task is not None:
                # Resuming an existing waiting task, not spawning a child: merge the payload
                # into that task's own containing process scope -- the same source
                # camunda:inputParameter resolution reads from (task.workflow.data). Without
                # this, a downstream task's declared ${payload_key} input mapping silently
                # resolves to None even though the payload plainly named it: the value only
                # ever survived by accident, riding SpiffWorkflow's default task.data
                # inheritance chain, which explicit input-mapped scopes no longer forward
                # unless the value is actually in workflow.data. See
                # docs/variable-scoping-plan.md.
                catching_task.workflow.data.update(payload)
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

    async def shutdown(self) -> None:
        """Cancel and await every still-running background job (agent turns).

        Without this, a job fired by asyncio.create_task() during a request
        outlives the app's own event loop shutdown, left to finish (or hang)
        on borrowed time. Bounded workspace I/O (see graph_agent.workspace) means a
        cancelled job now always finishes within WORKSPACE_OP_TIMEOUT_SECONDS
        rather than hanging indefinitely, so this itself stays bounded too.
        """
        pending = [job for job in self.jobs.values() if not job.done()]
        for job in pending:
            job.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _dispatch(self, workflow_id: str, _lock_held: bool = False) -> None:
        await jobs.dispatch(self, workflow_id, _lock_held)

    def jobs_for_workflow(self, workflow_id: str) -> list[asyncio.Task[None]]:
        return jobs.jobs_for_workflow(self, workflow_id)

    def _job_workflow(self, task_id: str, workflow_id: str) -> bool:
        return jobs.job_workflow(self, task_id, workflow_id)

    async def _run_pi(self, workflow_id: str, task_id: str) -> None:
        await jobs.run_pi(self, workflow_id, task_id)

    async def _complete_pi(
        self,
        workflow_id: str,
        task_id: str,
        result: AgentResult | PiResult,
        workspace_metadata: dict[str, Any] | None = None,
        prompt: str | None = None,
    ) -> None:
        await jobs.complete_pi(self, workflow_id, task_id, result, workspace_metadata=workspace_metadata, prompt=prompt)

    @staticmethod
    def _status(workflow: Any) -> str:
        if workflow.is_completed():
            return "completed"
        for task in workflow.get_tasks(state=TaskState.READY):
            if task.task_spec.__class__.__name__ == "UserTask":
                return "waiting_human"
        if any(isinstance(task.task_spec, CatchingEvent) for task in workflow.get_tasks(state=TaskState.WAITING)):
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
                    {"label": v.get("name", v.get("id")), "value": v.get("id")} for v in field["values"]
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

    async def merge_run(self, workflow_id: str, _lock_held: bool = False) -> dict[str, Any]:
        """Attempt to merge a completed worktree workflow's branch back into the base branch (§6)."""
        workflow_id = self._get_root_workflow_id(workflow_id)
        guard: Any = contextlib.nullcontext() if _lock_held else self._lock(workflow_id)
        async with guard:
            record = self._record(workflow_id)
            if record["status"] != "completed":
                msg = f"Run is in status {record['status']!r}; only completed runs can be merged"
                return {
                    "workflow_id": workflow_id,
                    "status": "merge_deferred",
                    "message": msg,
                }
            if not self.workspace or not self.workspace.is_git:
                msg = "Workspace is not a git repository"
                return {
                    "workflow_id": workflow_id,
                    "status": "unsupported",
                    "message": msg,
                }
            from graph_agent.workspace_strategy import WorktreeStrategy

            strategy = WorktreeStrategy(self.workspace)
            turns_count = sum(j.get("attempts", 1) for j in record.get("jobs", {}).values())
            bpmn_name = Path(record.get("bpmn_path", "workflow")).stem
            msg = f"Merge run {workflow_id[:8]} ({bpmn_name}, {turns_count} turn(s))"
            success, msg_result = await strategy.merge(workflow_id, commit_message=msg)
            if success:
                record["merge_status"] = "merged"
                record["merged_at"] = datetime.now(UTC).isoformat()
                record.pop("merge_error", None)
                await asyncio.to_thread(self.store.save, workflow_id, record)
                self.events.emit("run_merged", workflow_id, data={"message": msg_result})
                return {
                    "workflow_id": workflow_id,
                    "status": "merged",
                    "message": msg_result,
                }
            else:
                record["merge_status"] = "merge_deferred"
                record["merge_error"] = msg_result
                await asyncio.to_thread(self.store.save, workflow_id, record)
                self.events.emit("run_merge_deferred", workflow_id, data={"reason": msg_result})
                return {
                    "workflow_id": workflow_id,
                    "status": "merge_deferred",
                    "message": msg_result,
                }

    async def _maybe_auto_merge(self, workflow_id: str, record: dict[str, Any], _lock_held: bool = False) -> None:
        """Attempt auto-merge on clean completion if enabled (§6)."""
        if not self.workspace or not self.workspace.is_git:
            return
        wf_data = record.get("data") or {}
        merge_on_complete = wf_data.get("merge_on_complete", True)
        if isinstance(merge_on_complete, str):
            merge_on_complete = merge_on_complete.lower() in ("true", "1", "yes")
        if not merge_on_complete:
            logger.info("Auto-merge disabled for workflow %s", workflow_id)
            return

        logger.info("Attempting auto-merge for completed workflow %s", workflow_id)
        await self.merge_run(workflow_id, _lock_held=_lock_held)

    async def recover_orphaned_workflows(self) -> int:
        """Scan for orphaned workflows and clean up dangling worktrees.

        1. Workflows in 'waiting_pi', 'running', or 'retry_requested' with no active jobs
           are marked failed.
        2. Prune dangling worktrees for non-existent or terminated runs.
        """
        recovered = 0
        for item in self.instances():
            if item["status"] in ("waiting_pi", "running", "retry_requested"):
                record = self.store.load(item["workflow_id"])
                if not record:
                    continue
                jobs_map = record.get("jobs", {})
                active_job = any(job_id in self.jobs and not self.jobs[job_id].done() for job_id in jobs_map)
                if not active_job:
                    logger.warning(f"Recovering orphaned workflow: {item['workflow_id']}")
                    record["status"] = "failed"
                    record["failure_reason"] = "Recovered orphaned workflow on system startup"
                    for j in record.get("jobs", {}).values():
                        if j.get("status") in ("running", "retry_requested"):
                            j["status"] = "failed"
                            j["failure_reason"] = "Process terminated unexpectedly"
                    await asyncio.to_thread(self.store.save, item["workflow_id"], record)
                    recovered += 1

        if self.workspace and self.workspace.is_git and self.workspace.worktrees_dir.is_dir():
            from graph_agent.workspace_strategy import WorktreeStrategy

            strategy = WorktreeStrategy(self.workspace)
            for child in list(self.workspace.worktrees_dir.iterdir()):
                if child.is_dir():
                    run_id = child.name
                    rec = self.store.load(run_id)
                    if not rec or rec.get("status") in ("completed", "failed", "cancelled"):
                        with contextlib.suppress(Exception):
                            await strategy.discard(run_id)

        return recovered

    async def resume_pending_workflows(self) -> int:
        """Re-dispatch instances with READY or STARTED agent/script tasks after daemon restart."""
        resumed = 0
        for wf_id in self.store.list_active():
            record = self.store.load(wf_id)
            if not record or record.get("status") in ("completed", "cancelled", "failed"):
                continue
            workflow = record.get("workflow")
            if workflow is None:
                continue
            pending_tasks = [
                t
                for t in workflow.get_tasks()
                if t.state in (TaskState.READY, TaskState.STARTED)
                and t.task_spec.__class__.__name__ in ("ServiceTask", "ScriptTask")
            ]
            if pending_tasks:
                logger.info("Resuming pending workflow %s on startup", wf_id)
                await self._dispatch(wf_id)
                resumed += 1
        return resumed

    async def get_diff(self, workflow_id: str) -> dict[str, Any]:
        """Retrieve git diff of changes made in the instance worktree."""
        workflow_id = self._get_root_workflow_id(workflow_id)
        if not self.workspace or not self.workspace.is_git:
            return {"diff": "", "stat": "", "files_changed": [], "status": "no_git"}

        worktree_path = self.workspace.worktrees_dir / workflow_id
        if not worktree_path.is_dir():
            return {"diff": "", "stat": "", "files_changed": [], "status": "no_worktree"}

        import subprocess

        res = await asyncio.to_thread(
            subprocess.run,
            ["git", "diff", "HEAD"],
            cwd=str(worktree_path),
            capture_output=True,
            text=True,
        )
        diff_text = res.stdout or ""

        stat_res = await asyncio.to_thread(
            subprocess.run,
            ["git", "diff", "--stat", "HEAD"],
            cwd=str(worktree_path),
            capture_output=True,
            text=True,
        )
        stat_text = stat_res.stdout or ""

        names_res = await asyncio.to_thread(
            subprocess.run,
            ["git", "diff", "--name-status", "HEAD"],
            cwd=str(worktree_path),
            capture_output=True,
            text=True,
        )
        files = []
        for line in (names_res.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(maxsplit=1)
            if len(parts) == 2:
                status_code, filename = parts
                files.append({"status": status_code, "path": filename})

        return {
            "diff": diff_text,
            "stat": stat_text,
            "files_changed": files,
            "status": "ok",
        }
