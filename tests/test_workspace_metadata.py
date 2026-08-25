from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from bpmn_agent.workflow_service import WorkflowService
from bpmn_agent.workspace import (
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


@pytest.mark.anyio
async def test_unpack_workspace_gz_fallback() -> None:
    import io
    import tarfile

    from bpmn_agent.workspace import unpack_workspace

    # Create a tar.gz archive in memory
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = b"Hello from GZ archive"
        ti = tarfile.TarInfo(name="greeting.txt")
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))
    gz_bytes = buf.getvalue()

    workdir = await unpack_workspace(gz_bytes, prefix="bpmn-test-gz-")
    try:
        greeting_file = Path(workdir) / "greeting.txt"
        assert greeting_file.is_file()
        assert greeting_file.read_text() == "Hello from GZ archive"
    finally:
        cleanup_workspace(workdir)



@pytest.mark.anyio
async def test_unpack_workspace_plain_tar_no_compression() -> None:
    import io
    import tarfile

    from bpmn_agent.workspace import unpack_workspace

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        data = b"plain tar content"
        ti = tarfile.TarInfo(name="plain.txt")
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))

    workdir = await unpack_workspace(buf.getvalue(), prefix="bpmn-test-plain-")
    try:
        plain_file = Path(workdir) / "plain.txt"
        assert plain_file.is_file()
        assert plain_file.read_text() == "plain tar content"
    finally:
        cleanup_workspace(workdir)


@pytest.mark.anyio
async def test_unpack_workspace_empty_blob_returns_bare_workdir() -> None:
    from ZODB.blob import Blob

    from bpmn_agent.workspace import unpack_workspace

    blob = Blob()
    with blob.open("w") as f:
        f.write(b"")

    workdir = await unpack_workspace(blob, prefix="bpmn-test-empty-")
    try:
        assert Path(workdir).is_dir()
        assert list(Path(workdir).iterdir()) == []
    finally:
        cleanup_workspace(workdir)


@pytest.mark.anyio
async def test_unpack_workspace_unopenable_blob_returns_bare_workdir() -> None:
    from ZODB.blob import Blob

    from bpmn_agent.workspace import unpack_workspace

    # A freshly-constructed Blob has no committed data yet, so .open("r") raises.
    blob = Blob()
    workdir = await unpack_workspace(blob, prefix="bpmn-test-unopenable-")
    try:
        assert Path(workdir).is_dir()
    finally:
        cleanup_workspace(workdir)


@pytest.mark.anyio
async def test_pack_workspace_falls_back_to_gzip_when_tar_subprocess_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from bpmn_agent.workspace import pack_workspace

    def boom(*args, **kwargs):
        raise FileNotFoundError("no tar binary")

    monkeypatch.setattr(subprocess, "run", boom)

    workdir = tempfile.mkdtemp(prefix="bpmn-test-fallback-")
    try:
        (Path(workdir) / "file.txt").write_text("fallback content")
        blob = await pack_workspace(workdir)
        with blob.open("r") as f:
            data = f.read()
        assert data.startswith(b"\x1f\x8b")  # gzip magic bytes
    finally:
        cleanup_workspace(workdir)


@pytest.mark.anyio
async def test_pack_workspace_to_bytes_falls_back_to_gzip_when_tar_subprocess_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from bpmn_agent.workspace import pack_workspace_to_bytes

    def boom(*args, **kwargs):
        raise FileNotFoundError("no tar binary")

    monkeypatch.setattr(subprocess, "run", boom)

    workdir = tempfile.mkdtemp(prefix="bpmn-test-fallback-bytes-")
    try:
        (Path(workdir) / "file.txt").write_text("fallback content")
        data = await pack_workspace_to_bytes(workdir)
        assert data.startswith(b"\x1f\x8b")
    finally:
        cleanup_workspace(workdir)


def test_get_workspace_metadata_on_missing_directory() -> None:
    meta = get_workspace_metadata("/no/such/workspace/dir")
    assert meta == {"file_count": 0, "total_size": 0, "files": [], "artifacts": []}


@pytest.mark.anyio
async def test_extract_workspace_file_blocks_path_traversal() -> None:
    from bpmn_agent.workspace import extract_workspace_file

    workdir = tempfile.mkdtemp(prefix="bpmn-test-traversal-")
    try:
        (Path(workdir) / "safe.txt").write_text("safe content")
        blob = await pack_workspace(workdir)
        result = await extract_workspace_file(blob, "../../../etc/passwd")
        assert result is None
    finally:
        cleanup_workspace(workdir)


@pytest.mark.anyio
async def test_duplicate_blob() -> None:
    import transaction

    from bpmn_agent.persistence import WorkflowStore
    from bpmn_agent.workspace import duplicate_blob

    assert duplicate_blob(None) is None

    workdir = tempfile.mkdtemp(prefix="bpmn-test-dup-")
    store = WorkflowStore(":memory:")
    try:
        (Path(workdir) / "file.txt").write_text("dup me")
        blob = await pack_workspace(workdir)

        # duplicate_blob() reads blob.committed(), which requires the blob to have
        # gone through a real ZODB transaction commit first.
        conn = store.db.open()
        conn.root()["test_blob"] = blob
        transaction.commit()

        dup = duplicate_blob(blob)
        assert dup is not None
        with blob.open("r") as f_orig, dup.open("r") as f_dup:
            assert f_orig.read() == f_dup.read()
        conn.close()
    finally:
        store.close()
        cleanup_workspace(workdir)


def test_cleanup_workspace_ignores_non_bpmn_and_missing_paths() -> None:
    # Neither call should raise, and neither should touch anything real.
    cleanup_workspace("")
    cleanup_workspace("/tmp/not-a-bpmn-prefixed-dir")
    cleanup_workspace("/no/such/bpmn-directory-at-all")


@pytest.mark.anyio
async def test_state_exposes_workspace_metadata(service: WorkflowService) -> None:
    """The instance view's workspace-files panel renders from `state()`, not from a second fetch.

    `_dispatch` persists `record["workspace_metadata"]` after every agent turn, and
    `GET /instance/{id}/workspace/files` served it, but `_public_state` never surfaced it --
    so the panel's guard was always falsy and the card stayed `hidden` forever.
    """
    import asyncio

    started = await service.start("workflows/contract_review.bpmn", None, {"contract": "text"})
    await asyncio.gather(*list(service.jobs.values()))
    wf_id = started["workflow_id"]

    state = service.state(wf_id)
    meta = state.get("workspace_metadata")
    assert meta is not None, "state() must expose workspace_metadata for the instance UI"
    assert set(meta) >= {"file_count", "total_size", "files", "artifacts"}
    assert meta == service.store.get_workspace_metadata(wf_id)
