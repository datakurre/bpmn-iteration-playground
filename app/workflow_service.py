from __future__ import annotations

import asyncio
import copy
import logging
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from SpiffWorkflow.task import TaskState

from app.adapters.base import AgentResult, BaseAdapter
from app.adapters.mock_adapter import MockAdapter
from app.adapters.pi_adapter import PiAdapter
from app.adapters.registry import AdapterRegistry
from app.engine import WorkflowRunner
from app.events import EventBus, WorkflowEvent
from app.persistence import WorkflowStore
from app.pi_rpc import PiResult, PiRpcClient
from app.workspace import cleanup_workspace, get_workspace_metadata, pack_workspace, pack_workspace_to_bytes, unpack_workspace, duplicate_blob
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


class WorkflowNotFound(KeyError):
    pass


def _sanitize_output(output: dict[str, Any] | None) -> dict[str, Any]:
    """Sanitize agent output values to prevent memory bloat and unbounded data injection."""
    if not output:
        return {}
    max_length = 50_000
    sanitized: dict[str, Any] = {}
    for key, val in output.items():
        if isinstance(val, str) and len(val) > max_length:
            val = val[:max_length] + "...[truncated]"
        sanitized[key] = val
    return sanitized


class WorkflowService:
    def __init__(
        self,
        store: WorkflowStore,
        pi_client: PiRpcClient | BaseAdapter | None = None,
        adapter_registry: AdapterRegistry | None = None,
    ) -> None:
        self.store = store
        self.runner = WorkflowRunner()
        self.registry = adapter_registry or AdapterRegistry()
        self.events = EventBus(store)

        if pi_client is not None:
            if isinstance(pi_client, BaseAdapter):
                self.registry.register(pi_client)
            elif hasattr(pi_client, "run"):
                # Handle test FakePi or PiRpcClient
                class GenericAdapter(BaseAdapter):
                    def __init__(self, target: Any) -> None:
                        self.target = target

                    @property
                    def adapter_type(self) -> str:
                        return "pi_agent"

                    async def run(self, prompt: str, config: dict[str, str], cwd: str) -> AgentResult:
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
                        )

                self.registry.register(GenericAdapter(pi_client))
        else:
            default_timeout = float(os.getenv("PI_TIMEOUT_SECONDS", "1800"))
            self.registry.register(PiAdapter(PiRpcClient(timeout_seconds=default_timeout)))

        self.jobs: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

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
            raise WorkflowNotFound()
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
            "save_points": [self._save_point_summary(point) for point in record.get("save_points", [])],
            "events": record.get("events", []),
            "parent_workflow_id": record.get("parent_workflow_id"),
        }

    @staticmethod
    def _save_point_summary(point: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in point.items() if key != "workflow"}

    def _add_save_point(
        self,
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
        workspace_blob = record.get("workspace_blob")
        if not workspace_blob and hasattr(record.get("workflow"), "workspace_blob"):
            workspace_blob = getattr(record["workflow"], "workspace_blob", None)

        save_points.append(
            {
                "id": uuid.uuid4().hex,
                "key": key,
                "phase": phase,
                "resume_action": resume_action,
                "task_id": str(task.id),
                "task_name": getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                "status": record.get("status", "running"),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "data": dict(workflow.data),
                "tasks": self.runner.task_snapshot(workflow),
                "workflow": copy.deepcopy(workflow),
                "parent_workflow_id": record.get("parent_workflow_id"),
                "workspace_blob": duplicate_blob(workspace_blob),
            }
        )

    def _get_root_workflow_id(self, workflow_id: str) -> str:
        record = self.store.load(workflow_id)
        if not record:
            raise WorkflowNotFound()
        if record.get("parent_workflow_id"):
            return self._get_root_workflow_id(record["parent_workflow_id"])
        return workflow_id

    def _sync_children(self, root_workflow_id: str, record: dict[str, Any]) -> None:
        from SpiffWorkflow.task import TaskState
        
        def _sync(parent_id: str, parent_wf: Any) -> None:
            children_map = record.setdefault("data", {}).setdefault("__children", {})
            for task in parent_wf.get_tasks(state=TaskState.ANY_MASK):
                if type(task.task_spec).__name__ == "CallActivity" and hasattr(task, "workflow") and task.workflow:
                    task_id = str(task.id)
                    if task_id not in children_map:
                        children_map[task_id] = uuid.uuid4().hex
                    
                    child_id = children_map[task_id]
                    child_wf = task.workflow
                    
                    child_record = self.store.load(child_id)
                    called = getattr(task.task_spec, "calledElement", "")
                    bpmn_path = f"workflows/{called}.bpmn" if called else "unknown"
                    
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
                        
                    self.store.save(child_id, child_record)
                    _sync(child_id, child_wf)

        _sync(root_workflow_id, record["workflow"])
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

    def history_instances(self, status_filter: str | None = None) -> list[dict[str, Any]]:
        return self.store.list_metadata(status_filter=status_filter)

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

    async def pack_database(self, days: int = 0) -> dict[str, Any]:
        return await asyncio.to_thread(self.store.pack, days)

    async def storage_stats(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.store.storage_stats)

    def delete_instance(self, workflow_id: str) -> bool:
        for task_id, job in list(self.jobs.items()):
            if self._job_workflow(task_id, workflow_id) and not job.done():
                job.cancel()
        return self.store.delete(workflow_id)

    def clear_instances(self) -> int:
        for job in self.jobs.values():
            if not job.done():
                job.cancel()
        return self.store.clear()

    def diagram(self, workflow_id: str) -> str:
        record = self._record(workflow_id)
        path = Path(record["bpmn_path"]).resolve()
        if path.suffix != ".bpmn" or not path.is_file():
            raise FileNotFoundError(path)
        return path.read_text(encoding="utf-8")

    async def fork(self, workflow_id: str, save_point_id: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        workflow_id = self._get_root_workflow_id(workflow_id)
        logger.info("Forking workflow from savepoint", extra={"workflow_id": workflow_id, "save_point_id": save_point_id})
        source = self._record(workflow_id)
        point = self.store.load_save_point(save_point_id)
        if point is None:
            point = next(
                (candidate for candidate in source.get("save_points", []) if candidate.get("id") == save_point_id),
                None,
            )
        if point is None or point.get("workflow") is None:
            raise KeyError(save_point_id)
        workflow = copy.deepcopy(point["workflow"])
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
            source["bpmn_path"],
            source["process_id"],
            self._status(workflow),
            jobs={},
            save_points=copy.deepcopy(source.get("save_points", [])),
            events=[],
            forked_from=workflow_id,
            forked_from_save_point=save_point_id,
            workspace_blob=duplicate_blob(point.get("workspace_blob")),
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
        await self._dispatch(workflow_id)
        state = self.state(workflow_id)
        if state["status"] == "completed":
            self.events.emit("workflow_completed", workflow_id, data=state["data"])
        await ws_manager.broadcast(workflow_id, state)
        return state

    async def retry_task(self, workflow_id: str, task_id: str) -> dict[str, Any]:
        workflow_id = self._get_root_workflow_id(workflow_id)
        logger.info("Retrying failed task", extra={"workflow_id": workflow_id, "task_id": task_id})
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
        record["status"] = "retry_requested"
        self._add_save_point(
            record,
            workflow,
            task,
            "retry_requested",
            "run_harness",
            f":run_{job['generation']}",
        )
        await asyncio.to_thread(self.store.save, workflow_id, record)
        self._sync_children(workflow_id, record)
        await self._dispatch(workflow_id)
        state = self.state(workflow_id)
        await ws_manager.broadcast(workflow_id, state)
        return state

    async def _dispatch(self, workflow_id: str) -> None:
        workflow_id = self._get_root_workflow_id(workflow_id)
        async with self._lock(workflow_id):
            record = self._record(workflow_id)
            workflow = record["workflow"]
            jobs = record.setdefault("jobs", {})
            tasks_to_launch: list[tuple[str, str, int, int]] = []

            for task in self.runner.get_all_tasks(workflow, TaskState.STARTED):
                if task.task_spec.__class__.__name__ != "ServiceTask":
                    continue
                config = self.runner.pi_config(task)
                harness_type = config.get("harness_type", "pi_agent")
                if harness_type not in ("pi_agent", "mock_agent") and not self.registry.get(harness_type):
                    continue
                task_key = str(task.id)
                existing_job = jobs.get(task_key)
                if (existing_job and existing_job.get("status") == "running") or (task_key in self.jobs and not self.jobs[task_key].done()):
                    continue
                attempts = int(existing_job.get("attempts", 0)) if existing_job else 0
                attempts += 1
                generation = int(existing_job.get("generation", 0)) if existing_job else 0
                record["status"] = "waiting_pi"
                self._add_save_point(
                    record,
                    workflow,
                    task,
                    "before_harness",
                    "run_harness",
                    f":run_{generation}:attempt_{attempts}",
                )
                task_name = getattr(task.task_spec, "bpmn_name", task.task_spec.name)
                jobs[task_key] = {
                    "status": "running",
                    "task_name": task_name,
                    "attempts": attempts,
                    "generation": generation,
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
                    self.jobs[task_key] = asyncio.create_task(self._run_pi(workflow_id, task_key))
            else:
                record["status"] = self._status(workflow)
                for task in workflow.get_tasks(state=TaskState.READY):
                    if task.task_spec.__class__.__name__ == "UserTask":
                        self._add_save_point(record, workflow, task, "human_wait", "submit_human")
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

    def jobs_for_workflow(self, workflow_id: str) -> list[asyncio.Task[None]]:
        return [job for task_id, job in self.jobs.items() if not job.done() and self._job_workflow(task_id, workflow_id)]

    def _job_workflow(self, task_id: str, workflow_id: str) -> bool:
        record = self.store.load(workflow_id)
        return bool(record and task_id in record.get("jobs", {}))

    async def _run_pi(self, workflow_id: str, task_id: str) -> None:
        workflow_id = self._get_root_workflow_id(workflow_id)
        workdir = None
        ws_meta: dict[str, Any] | None = None
        blob = None
        try:
            record = self._record(workflow_id)
            task = self.runner.find_task(record["workflow"], task_id)
            config = self.runner.pi_config(task)
            harness_type = config.get("harness_type", "pi_agent")

            adapter = self.registry.get(harness_type) or self.registry.get("pi_agent")
            if not adapter:
                raise ValueError(f"No adapter registered for harness_type: {harness_type}")

            # Unpack per-instance workspace archive (TODO 05)
            blob_or_bytes = self.store.get_workspace(workflow_id)
            workdir = await unpack_workspace(blob_or_bytes, prefix=f"bpmn-{workflow_id[:8]}-")
            configured_cwd = os.getenv("PI_WORKDIR")
            cwd = configured_cwd if configured_cwd else workdir

            prompt = self.runner.prompt(workflow_id, task, record["workflow"])
            result = await adapter.run(prompt, config, cwd)

            # Capture generated artifacts and documents into the isolated instance workspace
            artifacts_list: list[str] = []
            if result.output and isinstance(result.output, dict):
                raw_artifacts = result.output.get("artifacts", [])
                if isinstance(raw_artifacts, list):
                    for art in raw_artifacts:
                        if isinstance(art, str):
                            artifacts_list.append(art)
                            src_file = Path(cwd) / art
                            dst_file = Path(workdir) / art
                            if src_file.is_file() and str(src_file.resolve()) != str(dst_file.resolve()):
                                dst_file.parent.mkdir(parents=True, exist_ok=True)
                                shutil.copy2(src_file, dst_file)
                            elif not dst_file.is_file():
                                doc_content = (
                                    result.output.get("document_text")
                                    or result.output.get("summary")
                                    or result.text
                                )
                                if doc_content:
                                    dst_file.parent.mkdir(parents=True, exist_ok=True)
                                    dst_file.write_text(doc_content)

            # If workflow data contains document content or markdown, ensure saved to file in workspace
            wf_data = record["workflow"].data
            if "document_content" in wf_data and wf_data["document_content"]:
                doc_file = Path(workdir) / "document.md"
                if not doc_file.exists():
                    doc_file.write_text(str(wf_data["document_content"]))
                if "document.md" not in artifacts_list:
                    artifacts_list.append("document.md")

            # Compute lightweight workspace manifest metadata
            ws_meta = get_workspace_metadata(workdir, artifacts=artifacts_list)
            record["workspace_metadata"] = ws_meta
            record["workflow"].data["workspace_metadata"] = ws_meta

            # Repack modified workspace back into storage
            if workdir and Path(workdir).exists():
                archive_bytes = await pack_workspace_to_bytes(workdir)
                self.store.set_workspace(workflow_id, archive_bytes)
                record["workspace_archive"] = archive_bytes
        except Exception as exc:
            logger.exception(f"Error running agent task {task_id}: {exc}")
            result = AgentResult("failed", None, "", [], str(exc), 1)
        finally:
            if workdir:
                cleanup_workspace(workdir)

        await self._complete_pi(workflow_id, task_id, result, workspace_metadata=ws_meta)

    async def _complete_pi(
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
                workflow.data["workspace_metadata"] = workspace_metadata

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
                record.setdefault("failure_history", []).append(
                    {
                        "task_id": task_id,
                        "attempt": job.get("attempts", 1),
                        "reason": failure_reason,
                    }
                )

            sanitized_output = _sanitize_output(result.output)
            task_data = {
                "agent_status": result.status,
                "agent_output": sanitized_output,
                "agent_text": result.text,
            }
            task.data.update(task_data)
            task.workflow.data.update(task_data)

            # Apply outputParameters mapping if defined (TODO 16)
            extensions = getattr(task.task_spec, "extensions", {}) or {}
            output_params = extensions.get("outputParameters", {})
            if output_params and sanitized_output:
                for target_var, source_expr in output_params.items():
                    if source_expr.startswith("${") and source_expr.endswith("}"):
                        source_key = source_expr[2:-1]
                        task.workflow.data[target_var] = sanitized_output.get(source_key)
                    else:
                        task.workflow.data[target_var] = sanitized_output.get(source_expr, source_expr)

            if failure_reason:
                task.data["failure_reason"] = failure_reason
                task.workflow.data["failure_reason"] = failure_reason

            attempt = job.get("attempts", 1)
            generation = job.get("generation", 0)
            self._add_save_point(
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
            else:
                self.events.emit(
                    "pi_failed",
                    workflow_id,
                    task_id=task_id,
                    task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                    data={"failure_reason": failure_reason, "exit_code": result.exit_code},
                )

            status = self._status(workflow) if result.status == "success" else "failed"
            if status == "failed":
                self.events.emit(
                    "workflow_failed",
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
                    self.store.save(item["workflow_id"], record)
                    recovered += 1
        return recovered
