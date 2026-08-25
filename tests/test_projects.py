from __future__ import annotations

import pytest

from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.pi_client import PiResult
from bpmn_agent.projects import DuplicateProjectError, ProjectNotFoundError, ProjectService, slugify
from bpmn_agent.workflow_service import WorkflowService

BPMN_PATH = "workflows/project.bpmn"


class FakePi:
    async def run(self, prompt: str, cwd: str) -> PiResult:
        return PiResult(
            "success",
            {"status": "success", "summary": "complete", "findings": [], "artifacts": [], "next_action": "continue"},
            "result",
            [],
            "",
            0,
        )


@pytest.fixture
def project_service() -> ProjectService:
    service = WorkflowService(WorkflowStore(":memory:"), FakePi())
    return ProjectService(service)


def test_slugify_collapses_and_strips_punctuation() -> None:
    assert slugify("Firmware Rewrite!!") == "firmware-rewrite"
    assert slugify("  a__b--c  ") == "a-b-c"


def test_slugify_returns_empty_for_nothing_sluggable() -> None:
    assert slugify("!!!") == ""
    assert slugify("") == ""


@pytest.mark.anyio
async def test_create_project_sets_name_and_slug(project_service: ProjectService) -> None:
    detail = await project_service.create("Firmware Rewrite", BPMN_PATH)
    assert detail["name"] == "Firmware Rewrite"
    assert detail["slug"] == "firmware-rewrite"
    assert detail["child_count"] == 0
    assert detail["state"] == {}


@pytest.mark.anyio
async def test_create_project_rejects_unsluggable_name(project_service: ProjectService) -> None:
    with pytest.raises(ValueError, match="letter or digit"):
        await project_service.create("!!!", BPMN_PATH)


@pytest.mark.anyio
async def test_create_project_rejects_duplicate_slug(project_service: ProjectService) -> None:
    await project_service.create("Firmware Rewrite", BPMN_PATH)
    with pytest.raises(DuplicateProjectError):
        await project_service.create("firmware rewrite", BPMN_PATH)


@pytest.mark.anyio
async def test_list_projects_only_lists_project_templates(project_service: ProjectService) -> None:
    await project_service.create("Alpha", BPMN_PATH)
    await project_service.service.start("workflows/bug_triage.bpmn", variables={"bug_report": "x"})
    projects = project_service.list_projects()
    assert [p["slug"] for p in projects] == ["alpha"]


@pytest.mark.anyio
async def test_resolve_accepts_slug_or_raw_workflow_id(project_service: ProjectService) -> None:
    detail = await project_service.create("Alpha", BPMN_PATH)
    assert project_service.resolve("alpha") == detail["workflow_id"]
    assert project_service.resolve(detail["workflow_id"]) == detail["workflow_id"]


def test_resolve_unknown_slug_raises(project_service: ProjectService) -> None:
    with pytest.raises(ProjectNotFoundError):
        project_service.resolve("does-not-exist")


@pytest.mark.anyio
async def test_spawn_adds_a_child_and_get_reflects_it(project_service: ProjectService) -> None:
    await project_service.create("Alpha", BPMN_PATH)
    await project_service.spawn("alpha", "do the thing")
    detail = project_service.get("alpha")
    assert detail["child_count"] == 1
    assert detail["open_child_count"] == 1
    assert detail["children"][0]["task_brief"] == "do the thing"


@pytest.mark.anyio
async def test_spawn_unknown_slug_raises(project_service: ProjectService) -> None:
    with pytest.raises(ProjectNotFoundError):
        await project_service.spawn("does-not-exist", "do the thing")


@pytest.mark.anyio
async def test_set_state_round_trips_through_the_side_store(project_service: ProjectService) -> None:
    await project_service.create("Alpha", BPMN_PATH)
    project_service.set_state("alpha", {"repo": "example/repo"})
    assert project_service.get("alpha")["state"] == {"repo": "example/repo"}
