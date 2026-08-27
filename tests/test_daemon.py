import contextlib
import os
import signal
import socket
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from graph_agent.agents_root import Workspace
from graph_agent.daemon import (
    RuntimeInfo,
    bind_free_port,
    generate_token,
    is_daemon_alive,
    read_runtime_file,
    remove_runtime_file,
    stop_daemon,
    write_runtime_file,
)


def _info(**overrides: object) -> RuntimeInfo:
    defaults: dict[str, object] = {
        "schema": 1,
        "pid": os.getpid(),
        "port": 12345,
        "url": "http://127.0.0.1:12345",
        "token": "tok",
        "started_at": "2026-01-01T00:00:00+00:00",
    }
    defaults.update(overrides)
    return RuntimeInfo(**defaults)  # type: ignore[arg-type]


def test_bind_free_port_actually_binds_and_is_connectable() -> None:
    sock = bind_free_port("127.0.0.1")
    try:
        port = sock.getsockname()[1]
        assert port > 0
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
    finally:
        sock.close()


def test_generate_token_is_random_and_url_safe() -> None:
    a, b = generate_token(), generate_token()
    assert a != b
    assert len(a) > 20


def test_write_then_read_runtime_file_round_trips(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    info = _info()

    write_runtime_file(workspace, info)
    loaded = read_runtime_file(workspace)

    assert loaded == info
    assert workspace.runtime_file.is_file()


def test_read_runtime_file_missing_returns_none(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    assert read_runtime_file(workspace) is None


def test_read_runtime_file_malformed_json_returns_none(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    workspace.runtime_file.write_text("not json", encoding="utf-8")
    assert read_runtime_file(workspace) is None


def test_read_runtime_file_missing_keys_returns_none(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    workspace.runtime_file.write_text('{"pid": 1}', encoding="utf-8")
    assert read_runtime_file(workspace) is None


def test_remove_runtime_file_is_idempotent(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    remove_runtime_file(workspace)  # no file yet -- must not raise
    write_runtime_file(workspace, _info())
    remove_runtime_file(workspace)
    assert not workspace.runtime_file.exists()
    remove_runtime_file(workspace)  # already gone -- still must not raise


def test_is_daemon_alive_false_for_dead_pid() -> None:
    # A pid essentially guaranteed not to exist.
    info = _info(pid=2**30)
    assert is_daemon_alive(info, check_http=False) is False


def test_is_daemon_alive_true_for_own_pid_without_http_check() -> None:
    info = _info(pid=os.getpid())
    assert is_daemon_alive(info, check_http=False) is True


def test_is_daemon_alive_false_when_health_check_fails() -> None:
    info = _info(pid=os.getpid(), url="http://127.0.0.1:1")  # nothing listens on port 1
    assert is_daemon_alive(info, check_http=True) is False


def test_is_daemon_alive_true_when_health_check_succeeds() -> None:
    info = _info(pid=os.getpid())
    with patch("graph_agent.daemon.httpx.get") as mock_get:
        mock_get.return_value = MagicMock(status_code=200)
        assert is_daemon_alive(info, check_http=True) is True
        mock_get.assert_called_once_with("http://127.0.0.1:12345/health", headers={"X-Admin-Token": "tok"}, timeout=1.0)


def test_is_daemon_alive_false_on_non_200() -> None:
    info = _info(pid=os.getpid())
    with patch("graph_agent.daemon.httpx.get") as mock_get:
        mock_get.return_value = MagicMock(status_code=401)
        assert is_daemon_alive(info, check_http=True) is False


def test_stop_daemon_no_runtime_file_returns_true(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    assert stop_daemon(workspace) is True


def test_stop_daemon_stale_pid_cleans_up_and_returns_true(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _info(pid=2**30))

    assert stop_daemon(workspace) is True
    assert not workspace.runtime_file.exists()


def test_stop_daemon_sends_sigterm_and_waits_for_exit(tmp_path: Path) -> None:
    import multiprocessing

    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    proc = multiprocessing.Process(target=time.sleep, args=(30,))
    proc.start()
    pid = proc.pid
    assert pid is not None
    try:
        write_runtime_file(workspace, _info(pid=pid))
        # stop_daemon reaps the child itself (see _reap_if_ours in daemon.py) whenever it
        # happens to be the parent, as this test is -- so this is the one place allowed to
        # observe the exit; a second waitpid from proc.join()/is_alive() afterwards would
        # just raise ChildProcessError on an already-reaped pid and confuse the test, not
        # the daemon logic under test.
        assert stop_daemon(workspace, timeout_seconds=5.0) is True
        assert not workspace.runtime_file.exists()
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        with contextlib.suppress(ProcessLookupError, ChildProcessError):
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


def test_stop_daemon_times_out_if_process_ignores_sigterm(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    write_runtime_file(workspace, _info(pid=os.getpid()))  # our own pid never dies mid-test

    with patch("graph_agent.daemon.os.kill") as mock_kill:
        assert stop_daemon(workspace, timeout_seconds=0.2) is False
        assert mock_kill.called
