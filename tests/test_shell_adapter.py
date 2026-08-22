from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app.adapters.registry import AdapterRegistry
from app.adapters.shell_adapter import ShellAdapter


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    return tmp_path


def test_shell_adapter_is_registered_under_its_harness_type() -> None:
    adapter = AdapterRegistry(auto_discover=False).get("shell")
    assert adapter is not None
    assert adapter.adapter_type == "shell"


@pytest.mark.anyio
async def test_successful_command_publishes_agent_shaped_output(workspace: Path) -> None:
    result = await ShellAdapter().run("ignored prompt", {"command": "echo hello"}, str(workspace))
    assert result.status == "success"
    assert result.exit_code == 0
    assert result.output is not None
    assert result.output["status"] == "success"
    assert "hello" in result.output["stdout"]
    assert result.output["next_action"] == "continue"


@pytest.mark.anyio
async def test_prompt_is_never_part_of_the_command(workspace: Path) -> None:
    """The command comes from BPMN properties only; agent-written data must not reach argv."""
    marker = workspace / "pwned"
    prompt = f"; touch {marker}"
    result = await ShellAdapter().run(prompt, {"command": "echo safe", "shell": "true"}, str(workspace))
    assert result.status == "success"
    assert not marker.exists()


@pytest.mark.anyio
async def test_nonzero_exit_fails_the_turn_by_default(workspace: Path) -> None:
    result = await ShellAdapter().run("", {"command": "sh -c 'exit 3'"}, str(workspace))
    assert result.status == "failed"
    assert result.exit_code == 3


@pytest.mark.anyio
async def test_nonzero_exit_is_routable_data_when_fail_on_error_is_off(workspace: Path) -> None:
    """The build-repair loop depends on this: a failed compile must not halt the instance.

    The turn itself succeeded (the command ran), so the task completes and the graph gets
    to branch on the published ${status}; only `fail_on_error` turns it into a halt.
    """
    result = await ShellAdapter().run(
        "", {"command": "sh -c 'echo boom >&2; exit 1'", "fail_on_error": "false"}, str(workspace)
    )
    assert result.status == "success"
    assert result.output is not None
    assert result.output["status"] == "failed"
    assert result.output["exit_code"] == 1
    assert "boom" in result.output["log"]
    assert result.output["findings"] == ["boom"]


@pytest.mark.anyio
async def test_timeout_reports_a_timeout_turn(workspace: Path) -> None:
    result = await ShellAdapter().run(
        "", {"command": f"{sys.executable} -c 'import time; time.sleep(30)'", "timeout": "1"}, str(workspace)
    )
    assert result.status == "timeout"
    assert "timed out" in result.stderr


@pytest.mark.anyio
async def test_missing_command_and_template_fails_loudly(workspace: Path) -> None:
    result = await ShellAdapter().run("", {}, str(workspace))
    assert result.status == "failed"
    assert "command" in result.stderr


@pytest.mark.anyio
async def test_workdir_escaping_the_workspace_is_refused(workspace: Path) -> None:
    result = await ShellAdapter().run("", {"command": "echo hi", "workdir": "../elsewhere"}, str(workspace))
    assert result.status == "failed"
    assert "escapes the workspace" in result.stderr


@pytest.mark.anyio
async def test_artifacts_are_globbed_relative_to_the_workspace_root(workspace: Path) -> None:
    config = {
        "command": "sh -c 'mkdir -p images && touch images/slide-01.png images/slide-02.png other.txt'",
        "artifacts": "images/*.png",
    }
    result = await ShellAdapter().run("", config, str(workspace))
    assert result.output is not None
    assert result.output["artifacts"] == ["images/slide-01.png", "images/slide-02.png"]


@pytest.mark.anyio
async def test_artifacts_from_a_subdirectory_stay_workspace_relative(workspace: Path) -> None:
    config = {
        "command": "sh -c 'touch built.pdf'",
        "workdir": "deck",
        "artifacts": "*.pdf",
    }
    result = await ShellAdapter().run("", config, str(workspace))
    assert result.output is not None
    assert result.output["artifacts"] == ["deck/built.pdf"]


@pytest.mark.anyio
async def test_extra_env_reaches_the_command(workspace: Path) -> None:
    config = {
        "command": "sh -c 'echo $DECK_MODE'",
        "env": json.dumps({"DECK_MODE": "handout"}),
    }
    result = await ShellAdapter().run("", config, str(workspace))
    assert result.output is not None
    assert "handout" in result.output["stdout"]


@pytest.mark.anyio
async def test_long_output_is_tailed_rather_than_stored_whole(workspace: Path) -> None:
    config = {
        "command": f"{sys.executable} -c 'print(\"x\" * 50000)'",
        "log_tail": "500",
    }
    result = await ShellAdapter().run("", config, str(workspace))
    assert result.output is not None
    assert len(result.output["stdout"]) < 1000
    assert result.output["stdout"].startswith("...[truncated]")


@pytest.mark.anyio
async def test_output_lines_are_streamed_as_events(workspace: Path) -> None:
    seen: list[dict[str, str]] = []

    async def on_event(ev: dict[str, str]) -> None:
        seen.append(ev)

    await ShellAdapter().run("", {"command": "sh -c 'echo one; echo two'"}, str(workspace), on_event=on_event)
    lines = [ev["line"] for ev in seen if ev["type"] == "shell_output"]
    assert lines == ["one", "two"]


@pytest.mark.anyio
async def test_template_scaffolds_the_workspace_without_a_command(workspace: Path) -> None:
    config = {"template": "beamer"}
    adapter = ShellAdapter()
    await adapter.prepare_workspace(str(workspace), config)
    assert (workspace / "Makefile").is_file()
    assert (workspace / "flake.nix").is_file()

    result = await adapter.run("", config, str(workspace))
    assert result.status == "success"
    assert result.output is not None
    assert "slides.tex" in result.output["artifacts"]


@pytest.mark.anyio
async def test_template_never_overwrites_existing_workspace_files(workspace: Path) -> None:
    """Later turns re-run prepare_workspace, so agent edits must survive scaffolding."""
    edited = workspace / "slides.tex"
    edited.write_text("% the agent's work\n")
    await ShellAdapter().prepare_workspace(str(workspace), {"template": "beamer"})
    assert edited.read_text() == "% the agent's work\n"
    assert (workspace / "Makefile").is_file()


@pytest.mark.anyio
async def test_unknown_template_is_skipped_not_silently_scaffolded(workspace: Path) -> None:
    adapter = ShellAdapter()
    await adapter.prepare_workspace(str(workspace), {"template": "../../app"})
    assert not any(workspace.iterdir())
    result = await adapter.run("", {"template": "../../app"}, str(workspace))
    assert result.status == "failed"
