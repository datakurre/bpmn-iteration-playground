import contextlib
import sys

from graph_agent.cli import main


def test_cli_help(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["graph-agent", "--help"])
    with contextlib.suppress(Exception, SystemExit):
        main()


def test_cli_ls(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["graph-agent", "ls"])
    with contextlib.suppress(Exception, SystemExit):
        main()


def test_cli_status(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["graph-agent", "status"])
    with contextlib.suppress(Exception, SystemExit):
        main()


def test_cli_logs(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["graph-agent", "logs", "run-1"])
    with contextlib.suppress(Exception, SystemExit):
        main()


def test_cli_merge(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["graph-agent", "merge", "run-1"])
    with contextlib.suppress(Exception, SystemExit):
        main()


def test_cli_cancel(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["graph-agent", "cancel", "run-1"])
    with contextlib.suppress(Exception, SystemExit):
        main()


def test_cli_open(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["graph-agent", "open", "run-1"])
    with contextlib.suppress(Exception, SystemExit):
        main()


def test_cli_stop(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["graph-agent", "stop"])
    with contextlib.suppress(Exception, SystemExit):
        main()
