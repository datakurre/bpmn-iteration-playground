"""The `bpmn serve` daemon: free-port binding and the `.agents/runtime.json` handshake.

Phase 2 of the meta-agent refactor (docs/meta-agent-refactor-plan.md). Binding the socket
ourselves before anything is reported is what makes "a free port" actually free rather
than probe-then-race: `bind_free_port` claims the port immediately, and nothing here
writes a URL anywhere until that bind has already succeeded.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import signal
import socket
import time
from dataclasses import dataclass
from typing import Any

import httpx

from graph_agent.agents_root import Workspace

RUNTIME_SCHEMA_VERSION = 1
_HEALTH_CHECK_TIMEOUT_SECONDS = 1.0


def bind_free_port(host: str, port: int = 0) -> socket.socket:
    """Bind a TCP socket on `host`, returning it still open and listening.

    `port=0` (the default) asks the OS for whatever's free. The caller hands this socket
    to uvicorn (`Server.run(sockets=[sock])`) rather than closing it -- closing and
    re-binding the reported port would race another process for it.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    return sock


def generate_token() -> str:
    return secrets.token_urlsafe(32)


@dataclass(frozen=True)
class RuntimeInfo:
    """The contents of `.agents/runtime.json` -- what a second `bpmn` invocation needs to
    find, verify, and talk to the daemon a first invocation started."""

    schema: int
    pid: int
    port: int
    url: str
    token: str
    started_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "pid": self.pid,
            "port": self.port,
            "url": self.url,
            "token": self.token,
            "started_at": self.started_at,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> RuntimeInfo | None:
        try:
            return cls(
                schema=int(raw["schema"]),
                pid=int(raw["pid"]),
                port=int(raw["port"]),
                url=str(raw["url"]),
                token=str(raw["token"]),
                started_at=str(raw["started_at"]),
            )
        except (KeyError, TypeError, ValueError):
            return None


def write_runtime_file(workspace: Workspace, info: RuntimeInfo) -> None:
    """Write `.agents/runtime.json` atomically (write-then-rename), so a concurrent
    `bpmn status` never observes a half-written file."""
    workspace.agents_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = workspace.runtime_file.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(info.to_dict(), indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(workspace.runtime_file)


def read_runtime_file(workspace: Workspace) -> RuntimeInfo | None:
    try:
        raw = json.loads(workspace.runtime_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    return RuntimeInfo.from_dict(raw)


def remove_runtime_file(workspace: Workspace) -> None:
    with contextlib.suppress(OSError):
        workspace.runtime_file.unlink()


def _reap_if_ours(pid: int) -> bool | None:
    """Non-blocking `waitpid`, in case `pid` happens to be a child of *this* process.

    Only relevant when `bpmn stop` (or a test) is itself the daemon's parent -- the normal
    case is an unrelated process, where `waitpid` raises `ChildProcessError` and this is a
    no-op. When it does apply, it matters: a signalled child that nobody reaps stays a
    zombie, and a zombie's PID slot still answers `kill(pid, 0)` as if it were running, so
    without this a same-process parent's own wait loop would never see it as dead. Returns
    True if reaped just now, False if still running, None if not our child at all.
    """
    try:
        reaped_pid, _status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return None
    return reaped_pid == pid


def _pid_alive(pid: int) -> bool:
    if _reap_if_ours(pid):
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists, just owned by someone else -- still "alive" as far as we're concerned.
        return True
    return True


def is_daemon_alive(info: RuntimeInfo, *, check_http: bool = True) -> bool:
    """A runtime.json is only trustworthy if its pid is alive *and*, when asked, the
    daemon actually answers /health with the token it claims -- a pid can be alive and
    reused by an unrelated process once the daemon that wrote it has exited.
    """
    if not _pid_alive(info.pid):
        return False
    if not check_http:
        return True
    try:
        resp = httpx.get(
            f"{info.url}/health",
            headers={"X-Admin-Token": info.token},
            timeout=_HEALTH_CHECK_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError:
        return False
    return resp.status_code == 200


def stop_daemon(workspace: Workspace, *, timeout_seconds: float = 5.0) -> bool:
    """Ask a running daemon to shut down gracefully (SIGTERM) and wait for it to exit.

    Returns True if a daemon was stopped, or none was running in the first place; False
    if one was running but didn't exit within `timeout_seconds`.
    """
    info = read_runtime_file(workspace)
    if info is None or not _pid_alive(info.pid):
        remove_runtime_file(workspace)
        return True
    with contextlib.suppress(ProcessLookupError):
        os.kill(info.pid, signal.SIGTERM)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not _pid_alive(info.pid):
            remove_runtime_file(workspace)
            return True
        time.sleep(0.1)
    return False
