import tempfile
from pathlib import Path

import pytest
from ZODB.blob import Blob

from graph_agent.persistence import SavePointSnapshot, WorkflowStore
from graph_agent.workspace import cleanup_workspace, pack_workspace_to_bytes, unpack_workspace


def _minimal_record() -> dict:
    return {"status": "running", "process_id": "proc1"}


def test_workflow_store_lists_and_cleans_instances() -> None:
    store = WorkflowStore(":memory:")
    store.save("one", {"status": "completed", "process_id": "proc1"})
    store.save("two", {"status": "waiting_human", "process_id": "proc2"})

    assert {workflow_id for workflow_id, _ in store.list()} == {"one", "two"}
    assert store.delete("one") is True
    assert store.delete("missing") is False
    assert store.clear() == 1
    assert store.list() == []
    store.close()


def test_savepoint_snapshot_independent_persistence() -> None:
    store = WorkflowStore(":memory:")
    sp = SavePointSnapshot(
        id="sp-100",
        workflow_id="wf-1",
        key="task1:before_harness",
        phase="before_harness",
        resume_action="run_harness",
        task_id="task1",
        task_name="Review Task",
        status="running",
        created_at="2026-08-19T00:00:00Z",
        data={"input": "test_contract"},
        tasks=[{"id": "task1", "state": "READY"}],
        workflow={"dummy": "mock_workflow_graph"},
    )
    store.save_save_point(sp)

    loaded = store.load_save_point("sp-100")
    assert loaded is not None
    assert loaded["id"] == "sp-100"
    assert loaded["phase"] == "before_harness"
    assert loaded["workflow"] == {"dummy": "mock_workflow_graph"}

    # Saving workflow with savepoints normalizes snapshot into root["save_points"]
    store.save(
        "wf-1",
        {
            "status": "running",
            "process_id": "contract_review",
            "save_points": [
                {
                    "id": "sp-200",
                    "workflow_id": "wf-1",
                    "phase": "after_harness",
                    "resume_action": "complete_harness",
                    "workflow": {"step": 2},
                    "data": {"decision": "ok"},
                }
            ],
        },
    )

    loaded_sp200 = store.load_save_point("sp-200")
    assert loaded_sp200 is not None
    assert loaded_sp200["phase"] == "after_harness"
    assert loaded_sp200["workflow"] == {"step": 2}

    # Loaded workflow only holds summary without unpickling workflow graph inside save_points
    loaded_wf = store.load("wf-1")
    assert loaded_wf is not None
    assert len(loaded_wf["save_points"]) == 1
    assert "workflow" not in loaded_wf["save_points"][0]

    store.close()


def test_metadata_indexing_and_fast_listing() -> None:
    store = WorkflowStore(":memory:")
    store.save("wf-a", {"status": "completed", "process_id": "p1", "bpmn_path": "a.bpmn", "tasks": [1, 2]})
    store.save("wf-b", {"status": "failed", "process_id": "p2", "bpmn_path": "b.bpmn", "failure_reason": "err"})

    all_meta = store.list_metadata()
    assert len(all_meta) == 2
    assert {m["workflow_id"] for m in all_meta} == {"wf-a", "wf-b"}

    completed_meta = store.list_metadata(status_filter="completed")
    assert len(completed_meta) == 1
    assert completed_meta[0]["workflow_id"] == "wf-a"

    failed_meta = store.list_metadata(status_filter="failed")
    assert len(failed_meta) == 1
    assert failed_meta[0]["failure_reason"] == "err"

    store.close()


def test_pack_and_storage_stats() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = str(Path(tmpdir) / "test.fs")
        store = WorkflowStore(db_path)

        for i in range(10):
            store.save("wf-temp", {"status": f"step_{i}", "data": {"val": "x" * 5000}})

        stats_before = store.storage_stats()
        assert stats_before["instances_count"] == 1
        assert stats_before["size_bytes"] > 0

        pack_res = store.pack(days=0)
        assert pack_res["reclaimed_bytes"] >= 0

        stats_after = store.storage_stats()
        assert stats_after["instances_count"] == 1
        assert stats_after["size_bytes"] <= stats_before["size_bytes"]

        store.close()


def test_save_updates_instance_in_place_preserving_persistent_identity() -> None:
    store = WorkflowStore(":memory:")
    store.save("wf-identity", {"status": "running", "data": {"count": 1}})

    with store.db.transaction() as conn:
        root = conn.root()
        inst1 = root["workflows"]["wf-identity"]
        oid1 = inst1._p_oid
        meta1 = root["metadata"]["wf-identity"]
        meta_oid1 = meta1._p_oid

    store.save("wf-identity", {"status": "completed", "data": {"count": 2}})

    with store.db.transaction() as conn:
        root = conn.root()
        assert len(root["workflows"]) == 1
        assert len(root["metadata"]) == 1
        inst2 = root["workflows"]["wf-identity"]
        assert inst2._p_oid == oid1
        assert inst2.status == "completed"
        assert inst2.data["count"] == 2
        meta2 = root["metadata"]["wf-identity"]
        assert meta2._p_oid == meta_oid1
        assert meta2.status == "completed"
        assert meta2.data["count"] == 2

    store.close()


def test_update_atomic_in_single_transaction() -> None:
    store = WorkflowStore(":memory:")
    store.save("wf-update", {"status": "running", "data": {"a": 1}})

    updated = store.update("wf-update", status="completed", data={"a": 1, "b": 2})
    assert updated["status"] == "completed"
    assert updated["data"] == {"a": 1, "b": 2}

    loaded = store.load("wf-update")
    assert loaded is not None
    assert loaded["status"] == "completed"
    assert loaded["data"] == {"a": 1, "b": 2}

    meta = store.list_metadata(status_filter="completed")
    assert len(meta) == 1
    assert meta[0]["workflow_id"] == "wf-update"

    store.close()


def test_concurrent_store_access() -> None:
    import concurrent.futures

    store = WorkflowStore(":memory:")

    def worker(worker_id: int) -> None:
        for i in range(10):
            wf_id = f"wf-worker-{worker_id}-{i}"
            store.save(wf_id, {"status": "running", "data": {"iter": i}})
            store.update(wf_id, status="completed", data={"iter": i, "done": True})
            loaded = store.load(wf_id)
            assert loaded is not None
            assert loaded["status"] == "completed"

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(worker, i) for i in range(8)]
        for f in concurrent.futures.as_completed(futures):
            f.result()

    meta = store.list_metadata()
    assert len(meta) == 80
    assert len(store.list()) == 80

    store.close()


def test_events_merged_on_save() -> None:
    store = WorkflowStore(":memory:")
    store.save("wf-events", {"status": "running", "events": [{"event_type": "ev1", "timestamp": "t1"}]})
    store.append_event("wf-events", {"event_type": "ev2", "timestamp": "t2"})

    # Caller loads dict, appends ev3, and saves dict back
    rec = store.load("wf-events")
    assert rec is not None
    rec["events"].append({"event_type": "ev3", "timestamp": "t3"})
    store.save("wf-events", rec)

    events = store.get_events("wf-events")
    event_types = [e["event_type"] for e in events]
    assert "ev1" in event_types
    assert "ev2" in event_types
    store.close()


def test_memory_storage_cleans_temp_blob_dir() -> None:
    import os
    store = WorkflowStore(":memory:")
    assert hasattr(store, "_temp_blob_dir")
    blob_dir = store._temp_blob_dir
    assert blob_dir is not None
    assert os.path.exists(blob_dir)

    store.close()
    assert not os.path.exists(blob_dir)


@pytest.mark.anyio
async def test_concurrent_async_workflow_store_operations() -> None:
    import asyncio
    store = WorkflowStore(":memory:")

    async def workflow_worker(idx: int) -> None:
        wf_id = f"async-wf-{idx}"
        # Initial save
        await asyncio.to_thread(
            store.save,
            wf_id,
            {"status": "running", "process_id": f"proc_{idx}", "data": {"counter": 0}},
        )
        # Concurrent updates
        for step in range(1, 6):
            await asyncio.to_thread(store.update, wf_id, data={"counter": step})
            await asyncio.to_thread(
                store.append_event,
                wf_id,
                {"event_type": f"step_{step}", "timestamp": str(step)},
            )
            # Concurrent savepoint creation
            sp = SavePointSnapshot(
                id=f"sp-{idx}-{step}",
                workflow_id=wf_id,
                key=f"task-{step}",
                phase="before_harness",
                resume_action="continue",
                task_id=f"t-{step}",
                task_name=f"Task {step}",
                status="running",
                created_at="2026-08-20T00:00:00Z",
                data={"step": step},
                tasks=[],
                workflow=None,
            )
            await asyncio.to_thread(store.save_save_point, sp)

    await asyncio.gather(*[workflow_worker(i) for i in range(10)])

    # Assert all 10 instances exist with final counter and 5 events and 5 savepoints
    for i in range(10):
        wf_id = f"async-wf-{i}"
        rec = store.load(wf_id)
        assert rec is not None
        assert rec["data"]["counter"] == 5
        events = store.get_events(wf_id)
        assert len(events) == 5
        for s in range(1, 6):
            sp = store.load_save_point(f"sp-{i}-{s}")
            assert sp is not None

    assert len(store.list()) == 10
    store.close()


def test_set_workspace_bytes_are_stored_as_blob() -> None:
    store = WorkflowStore(":memory:")
    store.save("wf1", _minimal_record())
    store.set_workspace("wf1", b"fake-tar-bytes")

    with store.db.transaction() as conn:
        inst = conn.root()["workflows"]["wf1"]
        assert inst.workspace_blob is not None, "bytes must be wrapped in a ZODB Blob"
        assert inst.workspace_archive is None, "raw bytes must not be kept on the object"

    assert store.get_workspace("wf1") == b"fake-tar-bytes"
    store.close()


def test_set_workspace_accepts_a_blob_unchanged() -> None:
    store = WorkflowStore(":memory:")
    store.save("wf1", _minimal_record())
    blob = Blob()
    with blob.open("w") as f:
        f.write(b"already-a-blob")
    store.set_workspace("wf1", blob)

    with store.db.transaction() as conn:
        inst = conn.root()["workflows"]["wf1"]
        assert inst.workspace_blob is blob
        assert inst.workspace_archive is None

    assert store.get_workspace("wf1") == b"already-a-blob"
    store.close()


def test_get_workspace_reads_legacy_archive_attribute() -> None:
    store = WorkflowStore(":memory:")
    store.save("wf1", _minimal_record())
    with store.db.transaction() as conn:  # simulate a pre-migration write
        inst = conn.root()["workflows"]["wf1"]
        inst.workspace_archive = b"legacy-bytes"
        inst.workspace_blob = None
        inst._p_changed = True
    assert store.get_workspace("wf1") == b"legacy-bytes"
    store.close()


@pytest.mark.anyio
async def test_workspace_blob_round_trips_real_archive(tmp_path: Path) -> None:
    store = WorkflowStore(":memory:")
    (tmp_path / "hello.txt").write_text("agent output")
    archive = await pack_workspace_to_bytes(str(tmp_path))
    store.save("wf1", _minimal_record())
    store.set_workspace("wf1", archive)

    workdir = await unpack_workspace(store.get_workspace("wf1"), prefix="bpmn-test-")
    try:
        assert (Path(workdir) / "hello.txt").read_text() == "agent output"
    finally:
        cleanup_workspace(workdir)
    store.close()



