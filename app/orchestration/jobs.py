"""The agent-turn job loop: launching, running, and reconciling one harness turn.

This is the data-flow AGENTS.md describes for a Pi service task (start -> dispatch ->
adapter.run -> parse -> publish -> savepoint). `dispatch` scans every STARTED
ServiceTask and launches a background `asyncio.Task` per turn (`run_pi`); `complete_pi`
reconciles that turn's `AgentResult` back into job/task/record/event state across every
outcome (success, cancelled, failed). Kept in one file because dispatch and completion
share the job-bookkeeping invariants (attempts, generation, session threading) closely
enough that splitting them further would just relocate the coupling, not remove it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Any

from SpiffWorkflow.task import TaskState

from app.adapters.base import AdapterCapabilities, AgentResult
from app.engine import resolve_scope_inputs
from app.paths import contained_path
from app.persistence import WorkspaceConflictError
from app.pi_client import PiResult
from app.workspace import (
    WORKSPACE_OP_TIMEOUT_SECONDS,
    cleanup_workspace,
    get_workspace_metadata,
    pack_workspace_to_bytes,
    unpack_workspace,
)
from app.ws import manager as ws_manager

if TYPE_CHECKING:
    from app.workflow_service import WorkflowService

logger = logging.getLogger("bpmn.workflow")

# The harness a task gets when its BPMN declares none. Existing templates omit
# harness_type entirely, so this stays pi_agent -- but it is the *default*, not a
# fallback: an explicitly declared harness that is not registered must fail loudly.
DEFAULT_HARNESS_TYPE = "pi_agent"

# Sentinel failure_reason for a workspace version conflict (see WorkflowStore.set_workspace).
# _complete_pi tags the job with "conflict" when it sees this message, and _dispatch's
# STARTED-task sweep skips relaunching a conflicted job -- otherwise a sibling branch's
# success re-triggers _dispatch instance-wide and silently re-runs the agent against a
# workspace it never actually agreed on, defeating the whole point of the conflict check.
# Only an explicit retry_task() call clears the flag.
WORKSPACE_CONFLICT_MESSAGE = "workspace changed during this turn; re-run against current state"

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
                dst_file = contained_path(workdir, art)
                src_file = contained_path(cwd, art)
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


def capabilities(service: WorkflowService, task: Any) -> AdapterCapabilities:
    """What the harness behind this task declares about itself.

    Falls back to a bare declaration named after the harness type so an unregistered
    or third-party harness still produces readable diagnostics.
    """
    harness_type = service.runner.pi_config(task).get("harness_type", DEFAULT_HARNESS_TYPE)
    adapter = service.registry.get(harness_type)
    return adapter.capabilities if adapter else AdapterCapabilities(display_name=harness_type)


def jobs_for_workflow(service: WorkflowService, workflow_id: str) -> list[asyncio.Task[None]]:
    return [job for task_id, job in service.jobs.items() if not job.done() and service._job_workflow(task_id, workflow_id)]


def job_workflow(service: WorkflowService, task_id: str, workflow_id: str) -> bool:
    record = service.store.load(workflow_id)
    return bool(record and task_id in record.get("jobs", {}))


async def dispatch(service: WorkflowService, workflow_id: str, _lock_held: bool = False) -> None:  # noqa: PLR0915 -- scans/launches every STARTED ServiceTask for the instance in one pass; pre-existing complexity
    workflow_id = service._get_root_workflow_id(workflow_id)
    guard: Any = contextlib.nullcontext() if _lock_held else service._lock(workflow_id)
    async with guard:
        record = service._record(workflow_id)
        workflow = record["workflow"]
        jobs = record.setdefault("jobs", {})
        tasks_to_launch: list[tuple[str, str, int, int]] = []
        unresolved: list[tuple[str, str, str]] = []

        for task in service.runner.get_all_tasks(workflow, TaskState.STARTED):
            if task.task_spec.__class__.__name__ != "ServiceTask":
                continue
            config = service.runner.pi_config(task)
            harness_type = config.get("harness_type", DEFAULT_HARNESS_TYPE)
            adapter = service.registry.get(harness_type)
            if adapter is None:
                task_key = str(task.id)
                task_name = getattr(task.task_spec, "bpmn_name", task.task_spec.name)
                if jobs.get(task_key, {}).get("status") != "failed":
                    reason = (
                        f"No adapter registered for harness_type {harness_type!r} "
                        f"(registered: {', '.join(sorted(service.registry.list_types()))})"
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
            if task_key in service.jobs and not service.jobs[task_key].done():
                continue
            attempts = int(existing_job.get("attempts", 0)) if existing_job else 0
            attempts += 1
            generation = int(existing_job.get("generation", 0)) if existing_job else 0

            extensions = getattr(task.task_spec, "extensions", {}) or {}
            scope_inputs = resolve_scope_inputs(extensions.get("inputParameters", {}), task.workflow.data)
            task.data = scope_inputs
            service._record_scope(
                record, task, "ServiceTask", status="active", inputs=scope_inputs, data=scope_inputs
            )

            record["status"] = "waiting_pi"
            service._add_save_point(
                workflow_id,
                record,
                workflow,
                task,
                "before_harness",
                "run_harness",
                f":run_{generation}:attempt_{attempts}",
            )
            task_name = getattr(task.task_spec, "bpmn_name", task.task_spec.name)
            # Only harnesses that carry conversational state take part in session
            # threading. A deterministic step holding an inherited id would register
            # as a colliding sibling below and force real agent turns to fork for
            # nothing.
            sessions = adapter.capabilities.supports_sessions
            inherited = service._inherited_session(workflow, task) if sessions else None
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
            record["tasks"] = service.runner.task_snapshot(workflow)
            await asyncio.to_thread(service.store.save, workflow_id, record)
            service._sync_children(workflow_id, record)
            for task_key, task_name, attempts, generation in tasks_to_launch:
                service.events.emit(
                    "pi_started",
                    workflow_id,
                    task_id=task_key,
                    task_name=task_name,
                    data={"attempt": attempts, "generation": generation},
                )
                job_task = asyncio.create_task(service._run_pi(workflow_id, task_key))

                def _on_done(_t: asyncio.Task[None], k: str = task_key) -> None:
                    service.jobs.pop(k, None)

                job_task.add_done_callback(_on_done)
                service.jobs[task_key] = job_task
        else:
            record["status"] = service._status(workflow)
            for task in workflow.get_tasks(state=TaskState.READY):
                if task.task_spec.__class__.__name__ == "UserTask":
                    extensions = getattr(task.task_spec, "extensions", {}) or {}
                    input_params = extensions.get("inputParameters", {})
                    scope_inputs = resolve_scope_inputs(input_params, task.workflow.data)
                    service._record_scope(record, task, "UserTask", status="active", inputs=scope_inputs)
                    service._add_save_point(workflow_id, record, workflow, task, "human_wait", "submit_human")
                    service.events.emit(
                        "human_task_ready",
                        workflow_id,
                        task_id=str(task.id),
                        task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                    )
            record["tasks"] = service.runner.task_snapshot(workflow)
            record["data"] = dict(workflow.data)
            await asyncio.to_thread(service.store.save, workflow_id, record)
            service._sync_children(workflow_id, record)
            # Unlike the tasks_to_launch branch above, nothing else broadcasts this
            # transition: _complete_pi() pushes state for the completed task *before*
            # calling _dispatch(), so a ServiceTask advancing straight into a UserTask
            # (status -> waiting_human, human_wait savepoint added) would otherwise never
            # reach a connected client until its next reconnect/poll.
            await ws_manager.broadcast(workflow_id, service.state(workflow_id))
            if record["status"] == "completed":
                service.events.emit("workflow_completed", workflow_id, data=record["data"])

        if unresolved:
            reason = unresolved[-1][2]
            record["failure_reason"] = reason
            record["status"] = "failed"
            record["tasks"] = service.runner.task_snapshot(workflow)
            await asyncio.to_thread(service.store.save, workflow_id, record)
            for task_key, task_name, task_reason in unresolved:
                logger.error("Unresolvable harness for task %s: %s", task_key, task_reason)
                service.events.emit(
                    "pi_failed",
                    workflow_id,
                    task_id=task_key,
                    task_name=task_name,
                    data={"failure_reason": task_reason},
                )
            service.events.emit("workflow_failed", workflow_id, data={"failure_reason": reason})


async def run_pi(service: WorkflowService, workflow_id: str, task_id: str) -> None:
    workflow_id = service._get_root_workflow_id(workflow_id)
    workdir = None
    ws_meta: dict[str, Any] | None = None
    try:
        record = service._record(workflow_id)
        task = service.runner.find_task(record["workflow"], task_id)
        config = service.runner.pi_config(task)

        job_entry = record.get("jobs", {}).get(task_id, {})
        session_id = job_entry.get("session_id")
        if session_id:
            config["session_id"] = str(session_id)
            if "fork" not in config:
                config["fork"] = "true" if job_entry.get("session_fork") else "false"

        harness_type = config.get("harness_type", DEFAULT_HARNESS_TYPE)

        # No fallback: running a shell task's prompt through Pi because ShellAdapter
        # happened not to be registered is worse than failing.
        adapter = service.registry.get(harness_type)
        if not adapter:
            raise ValueError(
                f"No adapter registered for harness_type {harness_type!r} "
                f"(registered: {', '.join(sorted(service.registry.list_types()))})"
            )

        # Unpack the per-instance workspace archive into a scratch directory the adapter
        # actually runs in -- see the module docstring's data-flow summary.
        blob_or_bytes = service.store.get_workspace(workflow_id)
        workspace_version = service.store.get_workspace_version(workflow_id)
        workdir = await unpack_workspace(blob_or_bytes, prefix=f"bpmn-{workflow_id[:8]}-")
        if not blob_or_bytes:
            await asyncio.wait_for(asyncio.to_thread(_seed_workspace, workdir), timeout=WORKSPACE_OP_TIMEOUT_SECONDS)
        cwd = workdir

        # Harness-specific workspace setup is the adapter's business, not ours
        await adapter.prepare_workspace(cwd, config)

        prompt = service.runner.prompt(workflow_id, task, record["workflow"])

        async def _on_event(ev: dict[str, Any]) -> None:
            with contextlib.suppress(Exception):
                await ws_manager.broadcast(workflow_id, {
                    "type": "pi_event",
                    "workflow_id": workflow_id,
                    "task_id": task_id,
                    "task_name": getattr(task, "name", task_id),
                    "event": ev,
                })

        result = await adapter.run(prompt, config, cwd, on_event=_on_event)

        # Capture generated artifacts and documents into the isolated instance workspace
        wf_data = record["workflow"].data
        _artifacts_list, ws_meta = await asyncio.wait_for(
            asyncio.to_thread(
                _process_workspace_artifacts,
                cwd,
                workdir,
                result.output,
                wf_data.get("document_content"),
            ),
            timeout=WORKSPACE_OP_TIMEOUT_SECONDS,
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
            service.store.set_workspace(workflow_id, archive_bytes, expected_version=workspace_version)
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

    await service._complete_pi(workflow_id, task_id, result, workspace_metadata=ws_meta)


async def complete_pi(  # noqa: C901, PLR0912, PLR0915 -- reconciles one agent-turn result into job/task/record/event state across every outcome (success/cancelled/failed); pre-existing complexity
    service: WorkflowService,
    workflow_id: str,
    task_id: str,
    result: AgentResult | PiResult,
    workspace_metadata: dict[str, Any] | None = None,
) -> None:
    workflow_id = service._get_root_workflow_id(workflow_id)
    async with service._lock(workflow_id):
        record = service._record(workflow_id)
        workflow = record["workflow"]
        task = service.runner.find_task(workflow, task_id)
        job = record.setdefault("jobs", {}).setdefault(task_id, {})
        if job.get("status") != "running":
            return

        if workspace_metadata:
            record["workspace_metadata"] = workspace_metadata

        net_data = getattr(result, "network", None)
        if net_data:
            record["network"] = net_data
            task.data["network"] = net_data
            with contextlib.suppress(Exception):
                await ws_manager.broadcast(workflow_id, {
                    "type": "network_summary",
                    "workflow_id": workflow_id,
                    "task_id": task_id,
                    "network": net_data,
                })

        policy_err = getattr(result, "policy_error", None)
        if policy_err:
            record["policy_error"] = policy_err
            task.data["policy_error"] = policy_err

        # Name the harness that actually ran. A failing `make pdf` reporting
        # "Pi exited with code 2" sends the reader hunting for a model misconfiguration.
        harness_caps = service._capabilities(task)
        harness_label = harness_caps.display_name

        failure_reason = None
        if result.status != "success":
            failure_reason = result.stderr.strip()
            if not failure_reason and result.exit_code not in (None, 0):
                failure_reason = f"{harness_label} exited with code {result.exit_code}"
            elif not failure_reason and not result.text:
                failure_reason = f"{harness_label} exited successfully without producing a result."
                if harness_caps.no_output_hint:
                    failure_reason = f"{failure_reason} {harness_caps.no_output_hint}"
            elif not failure_reason:
                failure_reason = (
                    f"{harness_label} returned output that did not match the required JSON result schema"
                )

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
            service._record_session(workflow, task, str(result.session_id))

        attempt = job.get("attempts", 1)
        generation = job.get("generation", 0)
        service._add_save_point(
            workflow_id,
            record,
            workflow,
            task,
            "after_harness",
            "complete_harness",
            f":run_{generation}:attempt_{attempt}",
        )

        scope_status = "completed" if result.status == "success" else ("cancelled" if result.status == "cancelled" else "failed")
        service._record_scope(
            record, task, "ServiceTask", status=scope_status, data=dict(task.data), outputs=published, completed=True
        )

        if result.status == "success":
            record.pop("failure_reason", None)
            task.workflow.data.pop("failure_reason", None)
            job["status"] = "success"
            job.pop("failure_reason", None)
            task.complete()
            workflow.do_engine_steps()
            service.events.emit(
                "pi_completed",
                workflow_id,
                task_id=task_id,
                task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                data=sanitized_output,
            )
        elif result.status == "cancelled":
            job["status"] = "cancelled"
            job["failure_reason"] = failure_reason
            service.events.emit(
                "pi_cancelled",
                workflow_id,
                task_id=task_id,
                task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                data={"failure_reason": failure_reason},
            )
        else:
            service.events.emit(
                "pi_failed",
                workflow_id,
                task_id=task_id,
                task_name=getattr(task.task_spec, "bpmn_name", task.task_spec.name),
                data={"failure_reason": failure_reason, "exit_code": result.exit_code},
            )

        status = service._status(workflow) if result.status == "success" else ("cancelled" if result.status == "cancelled" else "failed")
        if status == "failed":
            service.events.emit(
                "workflow_failed",
                workflow_id,
                data={"failure_reason": failure_reason},
            )
        elif status == "cancelled":
            service.events.emit(
                "workflow_cancelled",
                workflow_id,
                data={"failure_reason": failure_reason},
            )
        record.update(
            service.runner.record(
                workflow_id,
                workflow,
                record["bpmn_path"],
                record["process_id"],
                status,
                jobs=record["jobs"],
            )
        )
        await asyncio.to_thread(service.store.save, workflow_id, record)
        service._sync_children(workflow_id, record)
        state = service.state(workflow_id)
        await ws_manager.broadcast(workflow_id, state)

    if result.status == "success":
        await service._dispatch(workflow_id)
