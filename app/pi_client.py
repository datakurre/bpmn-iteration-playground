from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import signal
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger("bpmn.pi_client")

ALLOWED_ENV_VARS = {
    "PI_PROVIDER",
    "PI_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENCODE_ZEN_API_KEY",
    "OPENCODE_GO_API_KEY",
    "OPENCODE_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "AGENT_SANDBOX_PROXY_CA_FILE",
    "SSL_CERT_FILE",
    "PATH",
    "HOME",
    "TERM",
    "LANG",
    "LC_ALL",
    "NODE_PATH",
    "PI_EXECUTABLE",
    "PI_TIMEOUT_SECONDS",
    "PI_WORKDIR",
}


class PiError(RuntimeError):
    pass


@dataclass
class PiResult:
    status: str
    output: dict[str, Any] | None
    text: str
    messages: list[dict[str, Any]]
    stderr: str
    exit_code: int | None
    session_id: str | None = None


def _demo_fallback_allowed() -> bool:
    """Whether a failed real Pi run may silently fall back to the deterministic demo mock.

    Off by default: a misconfigured provider must fail loudly rather than feed fabricated
    agent output into BPMN gateway conditions.
    """
    return os.getenv("PI_ALLOW_DEMO_FALLBACK", "").strip().lower() in ("1", "true", "yes", "on")


def _kill_process_group_popen(process: subprocess.Popen[bytes]) -> None:
    """Kill the whole session started for Pi, not just its direct child.

    Pi is spawned with start_new_session=True, so process.kill() would leave the node
    runtime and any tool subprocesses it started running after a timeout or cancellation.

    killpg() is a plain syscall, not a blocking wait, so this is safe to call
    directly from a coroutine -- no thread needed. Reaping happens naturally:
    the reader thread's readline() unblocks once the killed process's stdout
    pipe closes, and _execute()'s to_thread(process.wait) picks up returncode.
    """
    if process.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        with contextlib.suppress(ProcessLookupError):
            process.kill()


def _set_resource_limits() -> None:
    """Set process resource limits for sandboxed Pi subprocess execution.

    Deliberately does not set RLIMIT_AS: Node/V8 reserves large virtual address space up
    front (pointer-compression cage, WASM linear memory arenas) independent of actual heap
    usage, and any RLIMIT_AS ceiling -- 2GB or 6GB, tested live against opencode.ai from
    this process tree -- reliably crashed every real (non-demo) Pi turn with
    "WebAssembly.instantiate(): Out of memory" inside undici's WASM llhttp parser as soon
    as it made a real HTTPS request. Memory containment for the Pi subprocess should come
    from the outer sandbox (agent-sandbox/Podman), not an in-process ulimit.
    """


def _final_text(events: list[dict[str, Any]]) -> str:
    for event in reversed(events):
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content", [])
        if isinstance(content, str):
            return content
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    for event in reversed(events):
        messages = event.get("messages")
        if not isinstance(messages, list):
            continue
        for message in reversed(messages):
            if message.get("role") != "assistant":
                continue
            content = message.get("content", [])
            if isinstance(content, str):
                return content
            return "".join(
                block.get("text", "")
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
    return ""


def _parse_json(text: str) -> dict[str, Any] | None:
    if not text or not isinstance(text, str):
        return None
    candidate = text.strip()
    if not candidate:
        return None
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", candidate, re.DOTALL)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        value = json.loads(candidate)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    required = {"status", "summary", "findings", "artifacts", "next_action"}
    if not required.issubset(value):
        return None
    if not isinstance(value["status"], str) or not isinstance(value["summary"], str) or not isinstance(value["next_action"], str):
        return None
    if not isinstance(value["findings"], list) or not isinstance(value["artifacts"], list):
        return None
    return value


class PiClient:
    """Stateless step-by-step client invoking Pi via non-interactive JSON print mode."""

    def __init__(
        self,
        executable: str | None = None,
        timeout_seconds: float = 1800,
        max_events: int = 10000,
    ) -> None:
        self._explicit_executable = executable is not None
        configured_executable = executable or os.getenv("PI_EXECUTABLE")
        root_dir = Path(__file__).resolve().parents[1]
        demo_executable = root_dir / "scripts" / "pi-demo"
        local_executable = root_dir / "node_modules" / ".bin" / "pi"

        if configured_executable:
            cand = Path(configured_executable)
            if not cand.is_absolute():
                cand_in_root = root_dir / configured_executable
                if cand_in_root.is_file():
                    configured_executable = str(cand_in_root.resolve())
            elif cand.is_file():
                configured_executable = str(cand.resolve())

        if not configured_executable and demo_executable.is_file() and (os.getenv("PI_OFFLINE") == "1" or not os.getenv("OPENAI_API_KEY")):
            configured_executable = str(demo_executable)
        self.executable = configured_executable or (str(local_executable) if local_executable.is_file() else "pi")
        self.timeout_seconds = timeout_seconds
        self.max_events = max_events

    async def run(
        self,
        prompt: str,
        cwd: str,
        on_event: Any = None,
        provider: str | None = None,
        model: str | None = None,
        timeout_seconds: int | None = None,
        session_id: str | None = None,
        fork: bool = False,
    ) -> PiResult:
        demo_executable = str(Path(__file__).resolve().parents[1] / "scripts" / "pi-demo")
        executable = self.executable
        if not self._explicit_executable and (os.getenv("PI_OFFLINE") == "1" or (Path(__file__).resolve().parents[1] / ".pi_offline").is_file()) and Path(demo_executable).is_file():
            executable = demo_executable
        result = await self._execute(
            executable,
            prompt,
            cwd,
            on_event=on_event,
            provider=provider,
            model=model,
            timeout_seconds=timeout_seconds,
            session_id=session_id,
            fork=fork,
        )
        if (
            result.status != "success"
            and _demo_fallback_allowed()
            and not self._explicit_executable
            and executable != demo_executable
            and Path(demo_executable).is_file()
        ):
            logger.warning(
                "Pi failed (%s); retrying with the deterministic demo mock because "
                "PI_ALLOW_DEMO_FALLBACK is set. Results are FABRICATED, not model output.",
                result.status,
            )
            demo_result = await self._execute(
                demo_executable,
                prompt,
                cwd,
                on_event=on_event,
                provider=provider,
                model=model,
                timeout_seconds=timeout_seconds,
                session_id=session_id,
                fork=fork,
            )
            if demo_result.status == "success":
                logger.warning("Returning FABRICATED demo-mock result for a failed Pi invocation")
                return demo_result
        return result

    async def _execute(  # noqa: C901, PLR0912, PLR0913, PLR0915 -- subprocess spawn/stream/timeout/cancel/parse lifecycle; pre-existing complexity
        self,
        executable: str,
        prompt: str,
        cwd: str,
        on_event: Any = None,
        provider: str | None = None,
        model: str | None = None,
        timeout_seconds: int | None = None,
        session_id: str | None = None,
        fork: bool = False,
    ) -> PiResult:
        # Non-interactive JSON print mode invocation
        command = [
            executable,
            "--mode",
            "json",
            "-p",
            prompt,
            "--no-approve",
        ]
        if session_id:
            if fork:
                command.extend(["--fork", session_id])
            else:
                command.extend(["--session", session_id])
        active_provider = provider or os.getenv("PI_PROVIDER")
        active_model = model or os.getenv("PI_MODEL")
        if active_provider:
            command.extend(["--provider", active_provider])
        if active_model:
            command.extend(["--model", active_model])

        env = {k: v for k, v in os.environ.items() if k in ALLOWED_ENV_VARS}
        if not env.get("OPENAI_API_KEY"):
            env["OPENAI_API_KEY"] = os.getenv("OPENCODE_GO_API_KEY") or os.getenv("OPENCODE_ZEN_API_KEY") or "secret-injected-by-proxy"
        if not env.get("OPENCODE_API_KEY"):
            env["OPENCODE_API_KEY"] = os.getenv("OPENCODE_GO_API_KEY") or os.getenv("OPENCODE_ZEN_API_KEY") or "secret-injected-by-proxy"
        if not env.get("NODE_EXTRA_CA_CERTS") and os.getenv("AGENT_SANDBOX_PROXY_CA_FILE"):
            env["NODE_EXTRA_CA_CERTS"] = os.getenv("AGENT_SANDBOX_PROXY_CA_FILE", "")
        if "NODE_USE_ENV_PROXY" not in env:
            env["NODE_USE_ENV_PROXY"] = "1"

        preexec = _set_resource_limits
        pi_user = os.getenv("PI_RUN_AS_USER")
        if pi_user:
            try:
                import pwd

                pw = pwd.getpwnam(pi_user)

                def _user_preexec() -> None:
                    _set_resource_limits()
                    os.setgid(pw.pw_gid)
                    os.setuid(pw.pw_uid)

                preexec = _user_preexec
            except Exception:
                preexec = _set_resource_limits

        logger.info(f"Spawning Pi process: {executable} in {cwd}")

        # Spawned via subprocess.Popen in a thread rather than
        # asyncio.create_subprocess_exec(): the latter registers the child with
        # asyncio's event-loop-bound child watcher, and this process runs inside
        # short-lived per-request event loops (Starlette's TestClient opens one
        # per call; each pytest-anyio test gets its own). Confirmed by
        # reproduction: creating and destroying enough such loops that each
        # spawn a subprocess this way corrupts the watcher's process-global
        # state, hanging an unrelated *later* loop's shutdown forever trying to
        # reap a task that has nothing to do with it. Popen's reaping happens
        # synchronously via os.waitpid() in the worker thread instead, never
        # touching that machinery. See app.workspace._run_tar for the same fix
        # applied to workspace pack/unpack.
        process = await asyncio.to_thread(
            subprocess.Popen,
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=preexec,
        )
        events: list[dict[str, Any]] = []
        stderr_msg = ""
        exit_code = None
        status = "failed"

        loop = asyncio.get_running_loop()
        line_queue: asyncio.Queue[bytes | None] = asyncio.Queue()

        def _pump_stdout() -> None:
            assert process.stdout is not None
            try:
                for line in iter(process.stdout.readline, b""):
                    loop.call_soon_threadsafe(line_queue.put_nowait, line)
            finally:
                loop.call_soon_threadsafe(line_queue.put_nowait, None)

        reader_thread = threading.Thread(target=_pump_stdout, daemon=True)
        reader_thread.start()

        active_timeout = timeout_seconds or self.timeout_seconds
        try:
            await asyncio.wait_for(self._read_output(line_queue, events, on_event=on_event), active_timeout)
            exit_code = await asyncio.to_thread(process.wait)
        except TimeoutError:
            _kill_process_group_popen(process)
            status = "timeout"
            stderr_msg = "Pi timed out"
        except asyncio.CancelledError:
            # Never leave the agent running after the orchestrator gives up on it.
            _kill_process_group_popen(process)
            raise
        except (BrokenPipeError, ConnectionError, PiError) as exc:
            _kill_process_group_popen(process)
            status = "failed"
            stderr_msg = str(exc)
        finally:
            raw_stderr = b""
            if process.stderr:
                with contextlib.suppress(Exception):
                    raw_stderr = await asyncio.to_thread(process.stderr.read)
            decoded_stderr = raw_stderr.decode(errors="replace")
            if stderr_msg:
                stderr_text = f"{stderr_msg}\n{decoded_stderr}".strip() if decoded_stderr else stderr_msg
            else:
                stderr_text = decoded_stderr
            reader_thread.join(timeout=5)

        branch_session_id = None
        for event in events:
            if event.get("type") == "session" and event.get("id"):
                branch_session_id = event["id"]

        text = _final_text(events)
        output = _parse_json(text)

        if status not in ("timeout",) and not stderr_msg:
            settled = any(event.get("type") == "agent_settled" for event in events)
            status = "success" if output is not None and (exit_code == 0 or settled) else "failed"

        return PiResult(status, output, text, events, stderr_text, exit_code, session_id=branch_session_id)

    async def _read_output(
        self,
        line_queue: asyncio.Queue[bytes | None],
        events: list[dict[str, Any]],
        on_event: Any = None,
    ) -> None:
        while True:
            line = await line_queue.get()
            if line is None:
                break
            if len(events) >= self.max_events:
                raise PiError("Pi emitted too many events")
            try:
                parsed = json.loads(line.decode(errors="replace"))
                events.append(parsed)
                if on_event and callable(on_event):
                    try:
                        res = on_event(parsed)
                        if asyncio.iscoroutine(res):
                            await res
                    except Exception:
                        pass
            except json.JSONDecodeError:
                pass


# Backward compatibility alias
PiRpcClient = PiClient
