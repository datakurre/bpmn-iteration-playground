from __future__ import annotations

import pickle
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from graph_agent.api.server import create_app
from graph_agent.engine import WorkflowRunner
from graph_agent.persistence import WorkflowStore
from graph_agent.workflow_service import WorkflowService

BPMN_DIR = Path(__file__).parent.parent / "graph_agent" / "data" / "workflows"


def test_extract_xml_from_fresh_workflow() -> None:
    """A freshly loaded workflow returns the original BPMN XML."""
    runner = WorkflowRunner()
    bpmn_path = str(BPMN_DIR / "plan_and_execute.bpmn")
    workflow, process_id = runner.load_workflow(bpmn_path)
    xml = runner.extract_bpmn_xml(workflow)
    assert "<?xml" in xml or "<bpmn:definitions" in xml or "<definitions" in xml
    assert process_id in xml


def test_extract_xml_contains_task_ids() -> None:
    """Extracted XML contains the BPMN IDs of tasks in the spec."""
    runner = WorkflowRunner()
    bpmn_path = str(BPMN_DIR / "plan_and_execute.bpmn")
    workflow, _ = runner.load_workflow(bpmn_path)
    xml = runner.extract_bpmn_xml(workflow)
    for task_id in workflow.spec.task_specs:
        if task_id not in ("Start", "End", "Root") and not task_id.endswith(".EndJoin"):
            assert task_id in xml


def test_extract_xml_survives_pickle_roundtrip() -> None:
    """After pickling and unpickling (simulating ZODB), XML is still available."""
    runner = WorkflowRunner()
    bpmn_path = str(BPMN_DIR / "plan_and_execute.bpmn")
    workflow, _ = runner.load_workflow(bpmn_path)
    original_xml = runner.extract_bpmn_xml(workflow)

    restored = pickle.loads(pickle.dumps(workflow))
    restored_xml = runner.extract_bpmn_xml(restored)
    assert restored_xml == original_xml


def test_extract_xml_fallback_reads_file() -> None:
    """A workflow without _bpmn_xml falls back to reading the _bpmn_path."""
    runner = WorkflowRunner()
    bpmn_path = str(BPMN_DIR / "plan_and_execute.bpmn")
    workflow, _ = runner.load_workflow(bpmn_path)
    if hasattr(workflow, "_bpmn_xml"):
        delattr(workflow, "_bpmn_xml")
    xml = runner.extract_bpmn_xml(workflow)
    assert xml  # Should fall back to reading the file
    assert "plan_and_execute" in xml


def test_extract_xml_no_source_raises() -> None:
    """A workflow with neither _bpmn_xml nor a readable path raises ValueError."""
    runner = WorkflowRunner()
    bpmn_path = str(BPMN_DIR / "plan_and_execute.bpmn")
    workflow, _ = runner.load_workflow(bpmn_path)
    if hasattr(workflow, "_bpmn_xml"):
        delattr(workflow, "_bpmn_xml")
    if hasattr(workflow, "_bpmn_path"):
        delattr(workflow, "_bpmn_path")
    with pytest.raises(ValueError, match="No BPMN XML"):
        runner.extract_bpmn_xml(workflow)


@pytest.mark.anyio
async def test_get_instance_spec_endpoint(tmp_path: Path) -> None:
    """GET /instance/{id}/spec returns the workflow's BPMN XML with application/xml media type."""
    db_path = str(tmp_path / "test.db")
    store = WorkflowStore(db_path)
    try:
        service = WorkflowService(store)
        bpmn_path = str(BPMN_DIR / "plan_and_execute.bpmn")
        instance = await service.start(bpmn_path, {})
        workflow_id = instance["workflow_id"]

        app = create_app(service)
        with TestClient(app) as client:
            # Valid instance
            response = client.get(f"/instance/{workflow_id}/spec")
            assert response.status_code == 200
            assert "application/xml" in response.headers.get("content-type", "")
            assert "plan_and_execute" in response.text

            # Non-existent instance
            bad_response = client.get("/instance/non-existent-id/spec")
            assert bad_response.status_code == 404
    finally:
        store.close()
