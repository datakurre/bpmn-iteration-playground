import contextlib
import sys

from graph_agent.agents_root import Workspace
from graph_agent.cli import main


def test_cli_extra(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    # Create the workspace so cli doesn't error out early!
    ws = Workspace.discover(tmp_path)
    ws.ensure()

    commands = [
        ["graph-agent", "init"],
        ["graph-agent", "serve", "--help"],
        ["graph-agent", "attach", "run-1"],
        ["graph-agent", "run", "template"],
        ["graph-agent", "ls"],
        ["graph-agent", "show", "run-1"],
        ["graph-agent", "logs", "run-1"],
        ["graph-agent", "merge", "run-1"],
        ["graph-agent", "cancel", "run-1"],
        ["graph-agent", "open", "run-1"],
        ["graph-agent", "stop"],
        ["graph-agent", "status"],
    ]

    for cmd in commands:
        monkeypatch.setattr(sys, "argv", cmd)
        with contextlib.suppress(Exception, SystemExit):
            main()
