from __future__ import annotations

import tempfile
from pathlib import Path
import pytest
from starlette.testclient import TestClient

from app.workspace import (
    cleanup_workspace,
    extract_workspace_file,
    get_workspace_metadata,
    pack_workspace,
)


@pytest.mark.anyio
async def test_workspace_metadata_and_single_file_extraction() -> None:
    workdir = tempfile.mkdtemp(prefix="bpmn-test-ws-")
    try:
        (Path(workdir) / "ADVERTISEMENT.md").write_text("# Workflow Studio Advertisement\n\nFast BPMN AI.")
        (Path(workdir) / "docs").mkdir()
        (Path(workdir) / "docs" / "guide.txt").write_text("User guide content.")

        # Compute metadata
        meta = get_workspace_metadata(workdir, artifacts=["ADVERTISEMENT.md"])
        assert meta["file_count"] == 2
        assert meta["total_size"] > 0
        file_paths = [f["path"] for f in meta["files"]]
        assert "ADVERTISEMENT.md" in file_paths
        assert "docs/guide.txt" in file_paths
        assert meta["artifacts"] == ["ADVERTISEMENT.md"]

        # Pack into blob
        blob = await pack_workspace(workdir)

        # Extract single file on demand
        extracted_ad = await extract_workspace_file(blob, "ADVERTISEMENT.md")
        assert extracted_ad is not None
        assert b"Workflow Studio Advertisement" in extracted_ad

        extracted_guide = await extract_workspace_file(blob, "docs/guide.txt")
        assert extracted_guide is not None
        assert b"User guide content." in extracted_guide

        # Missing file should return None
        missing = await extract_workspace_file(blob, "nonexistent.txt")
        assert missing is None
    finally:
        cleanup_workspace(workdir)


def test_workspace_api_endpoints(client: TestClient) -> None:
    # Start a workflow
    start_resp = client.post("/workflow/start", json={
        "bpmn_path": "workflows/contract_review.bpmn",
        "variables": {"contract": "Test contract agreement."}
    })
    assert start_resp.status_code == 200
    wf_id = start_resp.json()["workflow_id"]

    # Check /workspace/files endpoint
    files_resp = client.get(f"/instance/{wf_id}/workspace/files")
    assert files_resp.status_code == 200
    meta = files_resp.json()
    assert "file_count" in meta
    assert "files" in meta
