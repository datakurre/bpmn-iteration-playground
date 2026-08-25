from pathlib import Path
from unittest.mock import patch

from bpmn_agent.agents_root import Workspace
from bpmn_agent.cli import _materialize_bundled_workflows, main
from bpmn_agent.registry import BUNDLED_WORKFLOWS_DIR


def test_materialize_bundled_workflows_copies_every_bundled_template(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    copied, skipped = _materialize_bundled_workflows(workspace)

    bundled_names = {p.name for p in BUNDLED_WORKFLOWS_DIR.glob("*.bpmn")}
    assert copied == len(bundled_names)
    assert skipped == 0
    materialized_names = {p.name for p in workspace.workflows_dir.glob("*.bpmn")}
    assert materialized_names == bundled_names


def test_materialize_bundled_workflows_never_overwrites_existing_files(tmp_path: Path) -> None:
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    one_template = next(iter(BUNDLED_WORKFLOWS_DIR.glob("*.bpmn")))
    edited = workspace.workflows_dir / one_template.name
    edited.write_text("<!-- hand-edited -->", encoding="utf-8")

    copied, skipped = _materialize_bundled_workflows(workspace)

    assert skipped >= 1
    assert edited.read_text(encoding="utf-8") == "<!-- hand-edited -->"
    total_bundled = len(list(BUNDLED_WORKFLOWS_DIR.glob("*.bpmn")))
    assert copied + skipped == total_bundled


def test_cli_init_creates_agents_layout_and_prints_summary(tmp_path: Path, capsys) -> None:
    main(["init", "--workspace", str(tmp_path)])

    workspace = Workspace.discover(tmp_path)
    assert workspace.agents_dir.is_dir()
    assert workspace.state_dir.is_dir()
    assert list(workspace.workflows_dir.glob("*.bpmn"))

    out = capsys.readouterr().out
    assert "Initialized workspace" in out
    assert str(tmp_path.resolve()) in out


def test_cli_init_warns_when_not_a_git_repo(tmp_path: Path, capsys) -> None:
    main(["init", "--workspace", str(tmp_path)])

    out = capsys.readouterr().out
    assert "isn't a git repository" in out


def test_cli_init_is_quiet_about_git_when_workspace_is_a_repo(tmp_path: Path, capsys) -> None:
    (tmp_path / ".git").mkdir()

    main(["init", "--workspace", str(tmp_path)])

    out = capsys.readouterr().out
    assert "isn't a git repository" not in out


def test_cli_serve_defaults_when_no_command_given() -> None:
    with patch("bpmn_agent.cli.uvicorn.run") as mock_run:
        main([])
    mock_run.assert_called_once_with("bpmn_agent.api.server:app", host="127.0.0.1", port=8000, reload=False)


def test_cli_serve_subcommand_passes_through_flags() -> None:
    with patch("bpmn_agent.cli.uvicorn.run") as mock_run:
        main(["serve", "--host", "0.0.0.0", "--port", "9001", "--reload"])
    mock_run.assert_called_once_with("bpmn_agent.api.server:app", host="0.0.0.0", port=9001, reload=True)
