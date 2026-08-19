import tempfile
from pathlib import Path
from app.persistence import SavePointSnapshot, WorkflowInstance, WorkflowMetadata, WorkflowStore


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
