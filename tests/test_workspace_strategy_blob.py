import pytest

from bpmn_agent.persistence import WorkflowStore
from bpmn_agent.workspace_strategy import BlobStrategy


def _store_with_record(workflow_id: str = "wf1") -> WorkflowStore:
    store = WorkflowStore(":memory:")
    store.save(workflow_id, {"status": "running", "process_id": "p1"})
    return store


@pytest.mark.anyio
async def test_acquire_on_empty_workspace_returns_a_fresh_empty_dir() -> None:
    store = _store_with_record()
    strategy = BlobStrategy(store)

    workdir = await strategy.acquire("wf1")

    assert workdir.is_dir()
    assert list(workdir.iterdir()) == []
    await strategy.discard("wf1")
    assert not workdir.exists()
    store.close()


@pytest.mark.anyio
async def test_release_packs_written_files_back_into_the_store() -> None:
    store = _store_with_record()
    strategy = BlobStrategy(store)

    workdir = await strategy.acquire("wf1")
    (workdir / "output.md").write_text("hello", encoding="utf-8")
    await strategy.release("wf1")

    assert store.get_workspace("wf1") is not None

    workdir2 = await strategy.acquire("wf1")
    assert (workdir2 / "output.md").read_text(encoding="utf-8") == "hello"
    await strategy.discard("wf1")
    store.close()


@pytest.mark.anyio
async def test_release_raises_on_stale_expected_version() -> None:
    from bpmn_agent.persistence import WorkspaceConflictError

    store = _store_with_record()
    strategy = BlobStrategy(store)

    await strategy.acquire("wf1")
    # A concurrent turn advances the version underneath us.
    store.set_workspace("wf1", b"someone-elses-bytes")

    with pytest.raises(WorkspaceConflictError):
        await strategy.release("wf1")
    store.close()


@pytest.mark.anyio
async def test_snapshot_of_empty_workspace_is_none() -> None:
    store = _store_with_record()
    strategy = BlobStrategy(store)

    assert await strategy.snapshot("wf1", "before_harness") is None
    store.close()


@pytest.mark.anyio
async def test_snapshot_and_restore_round_trip_into_a_new_run() -> None:
    store = _store_with_record()
    store.save("wf2", {"status": "running", "process_id": "p1"})
    strategy = BlobStrategy(store)

    workdir = await strategy.acquire("wf1")
    (workdir / "notes.md").write_text("original", encoding="utf-8")
    await strategy.release("wf1")

    ref = await strategy.snapshot("wf1", "before_harness")
    assert ref is not None

    restored = await strategy.restore(ref, "wf2")
    assert (restored / "notes.md").read_text(encoding="utf-8") == "original"

    # The restored copy is independent -- mutating it must not touch the source.
    (restored / "notes.md").write_text("forked copy edited", encoding="utf-8")
    await strategy.release("wf2")
    reacquired_source = await strategy.acquire("wf1")
    assert (reacquired_source / "notes.md").read_text(encoding="utf-8") == "original"

    await strategy.discard("wf1")
    await strategy.discard("wf2")
    store.close()


@pytest.mark.anyio
async def test_release_with_persist_false_discards_scratch_edits() -> None:
    store = _store_with_record()
    strategy = BlobStrategy(store)

    workdir = await strategy.acquire("wf1")
    (workdir / "crash-scratch.md").write_text("never should be seen again", encoding="utf-8")
    await strategy.release("wf1", persist=False)

    assert store.get_workspace("wf1") is None
    assert not workdir.exists()
    store.close()
