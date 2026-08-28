"""End-to-end proof that a real WorkflowService run actually executes against a real git
worktree when a real Workspace is wired in -- not just the isolated strategy unit tests.
This is the behaviour phase 3 exists to deliver: "runs against the workspace where it was
launched", not a copy of nothing.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Any

import pytest

from graph_agent.adapters.base import AgentResult, BaseAdapter
from graph_agent.agents_root import Workspace
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService


class FileWritingAdapter(BaseAdapter):
    """Writes to the file named by the task's `output_file` camunda:property, and
    records the cwd it was actually invoked in, so the test can assert against it."""

    def __init__(self) -> None:
        self.cwds: list[str] = []

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str, on_event: Any = None) -> AgentResult:
        self.cwds.append(cwd)
        Path(cwd, config.get("output_file", "output.txt")).write_text("written by the agent turn")
        return AgentResult(
            "success",
            {"status": "success", "summary": "ok", "findings": [], "artifacts": [], "next_action": "continue"},
            "ok",
        )


def _init_git_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=root, check=True)
    (root / "README.md").write_text("project root\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-q", "-m", "initial"],
        cwd=root,
        check=True,
    )


async def _wait_for_agent_turns(service: WorkflowService) -> None:
    async def _wait() -> None:
        while any(not job.done() for job in list(service.jobs.values())):
            pending = [j for j in list(service.jobs.values()) if not j.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_wait(), timeout=5.0)


@pytest.mark.anyio
async def test_a_workspace_backed_service_runs_turns_in_a_real_git_worktree(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()
    assert workspace.is_git is True

    store = WorkflowStore(":memory:")
    adapter = FileWritingAdapter()
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(adapter)

    started = await service.start(
        "tests/fixtures/sequential_agents.bpmn",
        "sequential_agents",
        {"merge_on_complete": False},
    )
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    state = service.state(workflow_id)
    assert state["status"] == "completed"

    # The turn actually ran inside this workspace's own worktree, not an ephemeral
    # tempdir with no relationship to the real project.
    assert len(adapter.cwds) == 2
    expected_dir = str(workspace.worktrees_dir / workflow_id)
    for cwd in adapter.cwds:
        assert cwd == expected_dir

    worktree_path = workspace.worktrees_dir / workflow_id
    assert (worktree_path / "README.md").is_file(), "the real project's own files are present"
    assert (worktree_path / "file_1.txt").is_file()
    assert (worktree_path / "file_2.txt").is_file()

    # It is a real, separate git branch off the project's own history.
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=worktree_path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert branch == f"bpmn/run/{workflow_id}"

    store.close()


@pytest.mark.anyio
async def test_savepoint_before_and_after_harness_both_still_recorded(tmp_path: Path) -> None:
    """Worktree mode changes *where files live*, not whether savepoints exist -- the
    graph-level checkpoint history must survive regardless of workspace strategy."""
    _init_git_repo(tmp_path)
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(FileWritingAdapter())

    started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    record = store.load(workflow_id)
    assert record is not None
    phases = {sp["phase"] for sp in record.get("save_points", [])}
    assert "before_harness" in phases
    assert "after_harness" in phases

    store.close()


@pytest.mark.anyio
async def test_workspace_mode_task_property_overrides_the_git_default(tmp_path: Path) -> None:
    """Even inside a real git workspace, a task explicitly declaring workspace_mode=blob
    (beamer_slides.bpmn's own scaffold tasks, e.g.) must not get a worktree."""
    _init_git_repo(tmp_path)
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    store = WorkflowStore(":memory:")
    adapter = FileWritingAdapter()
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(adapter)

    bpmn = tmp_path / "blob_mode.bpmn"
    bpmn.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Definitions_Blob" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="blob_mode" name="Blob Mode" isExecutable="true">
    <bpmn:startEvent id="Start_1"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:serviceTask id="Task_1" name="Scaffold">
      <bpmn:extensionElements>
        <camunda:properties>
          <camunda:property name="harness_type" value="pi_agent" />
          <camunda:property name="output_file" value="scaffold.txt" />
          <camunda:property name="workspace_mode" value="blob" />
        </camunda:properties>
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
    <bpmn:endEvent id="End_1"><bpmn:incoming>Flow_2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>""",
        encoding="utf-8",
    )

    started = await service.start(str(bpmn), "blob_mode", {})
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    assert len(adapter.cwds) == 1
    cwd = adapter.cwds[0]
    assert not cwd.startswith(str(workspace.worktrees_dir))
    assert not (workspace.worktrees_dir / workflow_id).exists()
    assert store.get_workspace(workflow_id) is not None

    store.close()


@pytest.mark.anyio
async def test_worktree_savepoints_record_a_commit_sha_as_workspace_ref(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(FileWritingAdapter())

    started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    record = store.load(workflow_id)
    assert record is not None
    # record["save_points"] holds summaries after a store round-trip (to_summary(), which
    # deliberately excludes the workspace fields) -- the full checkpoint is only visible
    # via load_save_point() (to_dict()), the same path fork() itself reads through.
    after_harness_points = [sp for sp in record["save_points"] if sp["phase"] == "after_harness"]
    assert after_harness_points, "expected at least one after_harness savepoint"
    for summary in after_harness_points:
        full = store.load_save_point(summary["id"])
        assert full is not None
        assert full["workspace_blob"] is None, "worktree mode must not also write a blob"
        assert full["workspace_ref"] is not None
        assert len(full["workspace_ref"]) == 40  # a full git SHA

    store.close()


@pytest.mark.anyio
async def test_in_place_savepoints_carry_no_workspace_checkpoint_at_all(tmp_path: Path) -> None:
    """Not a git repo -> InPlaceStrategy -> supports_snapshot is False -> graph state is
    still captured (phases/tasks/data), but neither workspace field is ever set."""
    workspace = Workspace.discover(tmp_path)  # no .git -- InPlaceStrategy
    workspace.ensure()
    assert workspace.is_git is False

    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(FileWritingAdapter())

    started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    state = service.state(workflow_id)
    assert state["status"] == "completed"

    record = store.load(workflow_id)
    assert record is not None
    assert record["save_points"], "graph-level checkpoints still exist without a workspace strategy"
    for summary in record["save_points"]:
        full = store.load_save_point(summary["id"])
        assert full is not None
        assert full["workspace_blob"] is None
        assert full["workspace_ref"] is None

    store.close()


@pytest.mark.anyio
async def test_fork_of_worktree_savepoint_creates_a_new_worktree_at_that_commit(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    workspace = Workspace.discover(tmp_path)
    workspace.ensure()

    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(FileWritingAdapter())

    started = await service.start(
        "tests/fixtures/sequential_agents.bpmn",
        "sequential_agents",
        {"merge_on_complete": False},
    )
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    record = store.load(workflow_id)
    assert record is not None
    after_first_task = next(sp for sp in record["save_points"] if sp["phase"] == "after_harness")

    forked = await service.fork(workflow_id, after_first_task["id"])
    fork_id = forked["workflow_id"]
    await _wait_for_agent_turns(service)  # the fork's own dispatch spawns a new job

    fork_worktree = workspace.worktrees_dir / fork_id
    assert fork_worktree.is_dir()
    assert (fork_worktree / "file_1.txt").is_file(), "the source turn's files carried over"
    assert (fork_worktree / "README.md").is_file()

    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=fork_worktree,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert branch == f"bpmn/run/{fork_id}"

    # Independent of the source: mutating the fork must never touch the original.
    (fork_worktree / "fork_only.txt").write_text("only in the fork", encoding="utf-8")
    source_worktree = workspace.worktrees_dir / workflow_id
    assert not (source_worktree / "fork_only.txt").exists()

    store.close()


@pytest.mark.anyio
async def test_fork_of_in_place_savepoint_is_rejected(tmp_path: Path) -> None:
    from graph_agent.workspace_strategy import WorkspaceSnapshotUnsupportedError

    workspace = Workspace.discover(tmp_path)  # no .git -- InPlaceStrategy
    workspace.ensure()

    store = WorkflowStore(":memory:")
    service = WorkflowService(store, adapter_registry=None, workspace=workspace)
    service.registry.register(FileWritingAdapter())

    started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
    workflow_id = started["workflow_id"]
    await _wait_for_agent_turns(service)

    record = store.load(workflow_id)
    assert record is not None
    savepoint = next(sp for sp in record["save_points"] if sp["phase"] == "after_harness")

    with pytest.raises(WorkspaceSnapshotUnsupportedError) as exc_info:
        await service.fork(workflow_id, savepoint["id"])
    assert exc_info.value.mode == "in_place"

    store.close()


def test_fork_rejection_maps_to_a_typed_409(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from graph_agent.api.server import create_app

    async def scenario() -> dict:
        workspace = Workspace.discover(tmp_path)
        workspace.ensure()
        store = WorkflowStore(":memory:")
        service = WorkflowService(store, adapter_registry=None, workspace=workspace)
        service.registry.register(FileWritingAdapter())
        started = await service.start("tests/fixtures/sequential_agents.bpmn", "sequential_agents", {})
        workflow_id = started["workflow_id"]
        await _wait_for_agent_turns(service)
        record = store.load(workflow_id)
        assert record is not None
        savepoint = next(sp for sp in record["save_points"] if sp["phase"] == "after_harness")
        return {"service": service, "workflow_id": workflow_id, "save_point_id": savepoint["id"]}

    ctx = asyncio.run(scenario())
    app = create_app(ctx["service"])
    with TestClient(app) as client:
        resp = client.post(
            f"/instance/{ctx['workflow_id']}/fork/{ctx['save_point_id']}",
            json={},
        )
    assert resp.status_code == 409
    body = resp.json()["detail"]
    assert body["error"] == "workspace_snapshot_unsupported"
    assert body["mode"] == "in_place"
