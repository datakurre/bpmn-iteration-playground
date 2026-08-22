from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import os
from pathlib import Path
from typing import Any

from SpiffWorkflow.bpmn.specs.mixins.events.event_types import CatchingEvent
from SpiffWorkflow.bpmn.util import BpmnEvent
from SpiffWorkflow.task import TaskState

from app.adapters.base import AdapterCapabilities, AgentResult, BaseAdapter
from app.adapters.pi_adapter import PiAdapter
from app.adapters.registry import AdapterRegistry
from app.adapters.sandbox_adapter import SandboxPiAdapter
from app.engine import WorkflowRunner, resolve_output_mapping, resolve_scope_inputs
from app.events import EventBus
from app.orchestration import children, jobs, savepoints
from app.orchestration import fork as fork_module
from app.orchestration.jobs import (
    WORKSPACE_CONFLICT_MESSAGE,  # noqa: F401 -- re-exported for tests/test_workspace_concurrency.py
)
from app.persistence import WorkflowStore
from app.pi_client import PiClient, PiResult
from app.ws import manager as ws_manager

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

    The implementation is split by concern across `app/orchestration/`:
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
    ) -> None:
        self.store = store
        self.runner = WorkflowRunner()
        self.registry = adapter_registry or AdapterRegistry()
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
            # register() keys off adapter_type only, so re-registering the sandbox adapter
            # here used to leave the `agent_sandbox` alias and the PI_SANDBOX_ENABLED
            # binding pointing at the instance the registry built, with a different
            # timeout. Rebind every name that referred to the old one.
            self.registry.replace(SandboxPiAdapter(timeout_seconds=default_timeout))

        self.jobs: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._timer_task: asyncio.Task[None] | None = None

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
            "workspace_metadata": record.get("workspace_metadata")
            or record.get("data", {}).get("workspace_metadata"),
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
        savepoints.add_save_point(self, workflow_id, record, workflow, task, phase, resume_action, key_suffix)

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
                form_fields = extensions.get("form", {}).get("fields", []) if isinstance(extensions.get("form"), dict) else []
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
                raise ValueError("task does not have a failed harness attempt")
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

    async def shutdown(self) -> None:
        """Cancel and await every still-running background job (agent turns).

        Without this, a job fired by asyncio.create_task() during a request
        outlives the app's own event loop shutdown, left to finish (or hang)
        on borrowed time. Bounded workspace I/O (see app.workspace) means a
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
    ) -> None:
        await jobs.complete_pi(self, workflow_id, task_id, result, workspace_metadata=workspace_metadata)

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
                jobs_map = record.get("jobs", {})
                active_job = any(job_id in self.jobs and not self.jobs[job_id].done() for job_id in jobs_map)
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
