from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shlex
import shutil
from pathlib import Path
from typing import Any

from app.adapters.base import AgentResult, BaseAdapter

logger = logging.getLogger("bpmn.shell_adapter")

DEFAULT_TIMEOUT_SECONDS = 900.0
DEFAULT_LOG_TAIL = 8000
MAX_ARTIFACTS = 200
READ_CHUNK_BYTES = 65536
TEMPLATE_ROOT = Path(__file__).resolve().parents[2] / "workspace_templates"


def _contained(root: Path, relative: str) -> Path | None:
    """Resolve `relative` under `root`, or None if it escapes.

    Mirrors the orchestrator's own containment check: BPMN properties are authored
    alongside the code, but a template subdirectory or artifact glob still must not
    reach outside the instance workspace.
    """
    if not relative or relative.startswith(("/", "\\")) or "\x00" in relative:
        return None
    root_resolved = root.resolve()
    try:
        candidate = (root_resolved / relative).resolve()
    except (OSError, RuntimeError):
        return None
    if candidate != root_resolved and root_resolved not in candidate.parents:
        return None
    return candidate


def _split_list(raw: str | None) -> list[str]:
    """Parse a config value written either as a JSON array or a delimited string."""
    if not raw:
        return []
    stripped = raw.strip()
    if stripped.startswith("["):
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
    return [part for part in (p.strip() for p in re.split(r"[,\n]+", stripped)) if part]


def _tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return "...[truncated]\n" + text[-limit:]


class ShellAdapter(BaseAdapter):
    """Runs a declared command in the instance workspace: the deterministic half of a pipeline.

    This is the non-LLM adapter the registry was designed for. It ignores the generated
    prompt entirely -- the command comes only from the BPMN task's `camunda:properties`,
    never from workflow data. That distinction is the whole security model: workflow data
    is largely agent-written, and `resolve_input()` deliberately refuses to evaluate it as
    code, so a build step must not be able to smuggle agent text into an argv either.

    Recognised `camunda:property` names:

    ``command`` (required, unless ``template`` is set)
        The command line. Split with `shlex` and executed directly; no shell is involved
        unless ``shell`` is set.
    ``shell``
        ``true`` to run ``command`` through ``/bin/sh -c`` (needed for pipes/redirection).
    ``workdir``
        Subdirectory of the workspace to run in. Defaults to the workspace root.
    ``template``
        Name of a directory under ``workspace_templates/`` to lay down before the first
        run. Files already present in the workspace are never overwritten, so an agent's
        edits survive later turns of the same task.
    ``timeout``
        Seconds before the command is killed. Defaults to 900.
    ``artifacts``
        Glob patterns (JSON array or comma-separated) collected after the run and
        published as the task's ``artifacts``, which is what surfaces them in the
        workspace browser.
    ``fail_on_error``
        Defaults to ``true``: a non-zero exit fails the turn, halting the instance with a
        retryable failure. Set ``false`` when non-zero exit is a *routing* outcome rather
        than a breakage -- a compiler that rejects agent-written source is data the graph
        should branch on. The turn then succeeds while the published ``${status}`` is
        ``failed``, so an exclusive gateway can send the work back for another iteration.
    ``env``
        JSON object of extra environment variables for the command.
    ``log_tail``
        Maximum characters of stdout/stderr kept in the result. Defaults to 8000; the
        point is that a LaTeX log gets fed back into the next agent prompt, not stored.
    """

    def __init__(self, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self.timeout_seconds = timeout_seconds

    @property
    def adapter_type(self) -> str:
        return "shell"

    async def prepare_workspace(self, workdir: str, config: dict[str, str]) -> None:
        """Lay down the task's declared scaffold template, without clobbering existing work."""
        template = (config.get("template") or "").strip()
        if not template:
            return
        source = _contained(TEMPLATE_ROOT, template)
        if source is None or not source.is_dir():
            logger.warning("Shell task declares unknown workspace template %r; skipping", template)
            return
        target_root = Path(workdir)
        target_sub = (config.get("workdir") or "").strip()
        if target_sub:
            contained = _contained(target_root, target_sub)
            if contained is None:
                logger.warning("Shell task declares workdir %r escaping the workspace; skipping", target_sub)
                return
            target_root = contained
        await asyncio.to_thread(self._copy_template, source, target_root)

    @staticmethod
    def _copy_template(source: Path, target_root: Path) -> None:
        copied = 0
        for path in sorted(source.rglob("*")):
            if not path.is_file():
                continue
            destination = target_root / path.relative_to(source)
            if destination.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
            copied += 1
        logger.info("Seeded %d template file(s) from %s into %s", copied, source, target_root)

    async def run(  # noqa: C901, PLR0915 -- one subprocess lifecycle (spawn/stream/timeout/collect); splitting it would thread the same state through helpers
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
        on_event: Any = None,
    ) -> AgentResult:
        command = (config.get("command") or "").strip()
        if not command:
            # A task that only declares `template` is a scaffold step: prepare_workspace()
            # has already laid the files down, so there is nothing left to execute.
            template = (config.get("template") or "").strip()
            if template:
                return self._scaffold_result(template, config, cwd)
            return AgentResult(
                status="failed",
                output=None,
                text="",
                messages=[],
                stderr="Shell task declares neither a 'command' nor a 'template' property",
                exit_code=1,
            )

        resolved = self._resolve_invocation(command, config, cwd)
        if isinstance(resolved, str):
            return AgentResult(
                status="failed",
                output=None,
                text="",
                messages=[],
                stderr=resolved,
                exit_code=1,
            )
        argv, run_dir = resolved

        timeout_raw = (config.get("timeout") or config.get("timeout_seconds") or "").strip()
        timeout_seconds = float(timeout_raw) if timeout_raw.replace(".", "", 1).isdigit() else self.timeout_seconds
        log_tail_raw = (config.get("log_tail") or "").strip()
        log_tail = int(log_tail_raw) if log_tail_raw.isdigit() else DEFAULT_LOG_TAIL

        env = dict(os.environ)
        raw_env = (config.get("env") or "").strip()
        if raw_env:
            try:
                parsed_env = json.loads(raw_env)
                if isinstance(parsed_env, dict):
                    env.update({str(k): str(v) for k, v in parsed_env.items()})
            except (json.JSONDecodeError, TypeError) as exc:
                logger.warning("Shell task 'env' is not a JSON object (%s); ignoring", exc)

        logger.info("Executing shell task: %s (cwd: %s)", command, run_dir)

        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(run_dir),
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, ValueError) as exc:
            logger.error("Failed to spawn shell task %r: %s", command, exc)
            return AgentResult(
                status="failed",
                output=None,
                text="",
                messages=[],
                stderr=f"Failed to spawn {argv[0]!r}: {exc}",
                exit_code=1,
            )

        events: list[dict[str, Any]] = []
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []

        async def _pump(stream: asyncio.StreamReader | None, name: str, sink: list[str]) -> None:
            """Stream one pipe, emitting a UI event per line.

            Reads fixed-size chunks rather than readline(): a LaTeX log can carry a single
            line longer than StreamReader's 64 KiB limit, which readline() turns into an
            exception instead of output.
            """
            if stream is None:
                return
            pending = ""
            while True:
                chunk = await stream.read(READ_CHUNK_BYTES)
                if not chunk:
                    break
                text = chunk.decode("utf-8", errors="replace")
                sink.append(text)
                pending += text
                *lines, pending = pending.split("\n")
                for line in lines:
                    ev = {"type": "shell_output", "stream": name, "line": line.rstrip("\r")}
                    events.append(ev)
                    if on_event and callable(on_event):
                        try:
                            res = on_event(ev)
                            if asyncio.iscoroutine(res):
                                await res
                        except Exception:
                            pass
            if pending:
                ev = {"type": "shell_output", "stream": name, "line": pending.rstrip("\r")}
                events.append(ev)
                if on_event and callable(on_event):
                    try:
                        res = on_event(ev)
                        if asyncio.iscoroutine(res):
                            await res
                    except Exception:
                        pass

        pumps = asyncio.gather(
            _pump(process.stdout, "stdout", stdout_chunks),
            _pump(process.stderr, "stderr", stderr_chunks),
        )

        async def _drain_and_wait() -> int:
            await pumps
            return await process.wait()

        try:
            exit_code = await asyncio.wait_for(_drain_and_wait(), timeout=timeout_seconds)
        except TimeoutError:
            pumps.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pumps
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
            return AgentResult(
                status="timeout",
                output=None,
                text="",
                messages=events,
                stderr=f"Command timed out after {timeout_seconds:g}s: {command}",
                exit_code=1,
            )
        except asyncio.CancelledError:
            pumps.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pumps
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
            return AgentResult(
                status="cancelled",
                output=None,
                text="",
                messages=events,
                stderr=f"Command was cancelled: {command}",
                exit_code=1,
            )

        stdout = "".join(stdout_chunks)
        stderr = "".join(stderr_chunks)
        artifacts = await asyncio.to_thread(self._collect_artifacts, run_dir, Path(cwd), config.get("artifacts"))

        succeeded = exit_code == 0
        summary = (
            f"`{command}` succeeded"
            if succeeded
            else f"`{command}` exited with code {exit_code}"
        )
        findings: list[str] = []
        if not succeeded:
            error_lines = [ln.rstrip() for ln in (stderr or stdout).splitlines() if ln.strip()]
            findings = error_lines[-20:]

        output: dict[str, Any] = {
            "status": "success" if succeeded else "failed",
            "summary": summary,
            "command": command,
            "exit_code": exit_code,
            "stdout": _tail(stdout, log_tail),
            "stderr": _tail(stderr, log_tail),
            "log": _tail(stdout + stderr, log_tail),
            "findings": findings,
            "artifacts": artifacts,
            "next_action": "continue" if succeeded else "revise",
        }

        # A non-zero exit is a *result*, not necessarily a broken turn. Only fail the turn
        # -- which halts the instance for a human Retry -- when the template asked for it.
        fail_on_error = (config.get("fail_on_error") or "true").strip().lower() not in ("0", "false", "no")
        turn_status = "failed" if (not succeeded and fail_on_error) else "success"

        return AgentResult(
            status=turn_status,
            output=output,
            text=summary,
            messages=events,
            stderr=_tail(stderr, log_tail) if not succeeded else "",
            exit_code=exit_code,
        )

    @staticmethod
    def _resolve_invocation(
        command: str, config: dict[str, str], cwd: str
    ) -> tuple[list[str], Path] | str:
        """Turn the declared command into an argv plus run directory, or an error message."""
        run_dir = Path(cwd)
        sub = (config.get("workdir") or "").strip()
        if sub:
            contained = _contained(run_dir, sub)
            if contained is None:
                return f"Shell task 'workdir' {sub!r} escapes the workspace"
            contained.mkdir(parents=True, exist_ok=True)
            run_dir = contained

        if (config.get("shell") or "").strip().lower() in ("1", "true", "yes"):
            return ["/bin/sh", "-c", command], run_dir

        try:
            argv = shlex.split(command)
        except ValueError as exc:
            return f"Shell task 'command' is not parseable: {exc}"
        if not argv:
            return "Shell task 'command' is empty after parsing"
        return argv, run_dir

    def _scaffold_result(self, template: str, config: dict[str, str], cwd: str) -> AgentResult:
        """Report what the declared template contributed, with no command to run."""
        run_dir = Path(cwd)
        sub = (config.get("workdir") or "").strip()
        if sub:
            contained = _contained(run_dir, sub)
            if contained is not None:
                run_dir = contained
        source = _contained(TEMPLATE_ROOT, template)
        if source is None or not source.is_dir():
            return AgentResult(
                status="failed",
                output=None,
                text="",
                messages=[],
                stderr=f"Unknown workspace template {template!r}",
                exit_code=1,
            )
        declared = config.get("artifacts")
        artifacts = (
            self._collect_artifacts(run_dir, Path(cwd), declared)
            if declared
            else sorted(
                str((run_dir / path.relative_to(source)).relative_to(Path(cwd).resolve()))
                for path in source.rglob("*")
                if path.is_file()
            )
        )
        summary = f"Scaffolded workspace template {template!r} ({len(artifacts)} file(s))"
        return AgentResult(
            status="success",
            output={
                "status": "success",
                "summary": summary,
                "template": template,
                "exit_code": 0,
                "stdout": "",
                "stderr": "",
                "log": "",
                "findings": [],
                "artifacts": artifacts,
                "next_action": "continue",
            },
            text=summary,
            messages=[],
            stderr="",
            exit_code=0,
        )

    @staticmethod
    def _collect_artifacts(run_dir: Path, workspace_root: Path, raw_patterns: str | None) -> list[str]:
        """Expand the declared globs into workspace-relative paths that actually exist.

        Paths are relative to the workspace root rather than the run directory, because
        that is the namespace `_process_workspace_artifacts` and the workspace browser use.
        """
        patterns = _split_list(raw_patterns)
        if not patterns:
            return []
        root = workspace_root.resolve()
        collected: list[str] = []
        seen: set[str] = set()
        for pattern in patterns:
            if pattern.startswith(("/", "\\")):
                logger.warning("Ignoring absolute artifact pattern %r", pattern)
                continue
            try:
                matches = sorted(run_dir.glob(pattern))
            except (ValueError, OSError) as exc:
                logger.warning("Ignoring unusable artifact pattern %r: %s", pattern, exc)
                continue
            for match in matches:
                if not match.is_file():
                    continue
                try:
                    relative = str(match.resolve().relative_to(root))
                except ValueError:
                    logger.warning("Ignoring artifact %s outside the workspace", match)
                    continue
                if relative in seen:
                    continue
                seen.add(relative)
                collected.append(relative)
                if len(collected) >= MAX_ARTIFACTS:
                    logger.warning("Artifact list truncated at %d entries", MAX_ARTIFACTS)
                    return collected
        return collected
