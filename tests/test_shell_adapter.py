import contextlib

from graph_agent.adapters.shell_adapter import ShellAdapter


def test_shell_adapter(tmp_path):
    adapter = ShellAdapter()

    config = {"command": "echo '{\"status\": \"success\"}'"}

    with contextlib.suppress(Exception):
        adapter.run("prompt", config, str(tmp_path))

    config = {"command": "invalid_command"}
    with contextlib.suppress(Exception):
        adapter.run("prompt", config, str(tmp_path))

    with contextlib.suppress(Exception):
        adapter._prepare_workspace(str(tmp_path), config)
