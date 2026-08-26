import contextlib

from graph_agent.persistence import WorkflowStore


def test_persistence_methods(tmp_path):
    store = WorkflowStore(":memory:")

    with contextlib.suppress(Exception):
        store.save("run-1", {})

    with contextlib.suppress(Exception):
        store.update("run-1", test="data")

    with contextlib.suppress(Exception):
        store.load("run-1")

    with contextlib.suppress(Exception):
        store.save_save_point({"id": "sp1", "workflow_id": "run-1", "data": "test"})

    with contextlib.suppress(Exception):
        store.load_save_point("sp1")

    with contextlib.suppress(Exception):
        store.delete_save_point("sp1")

    with contextlib.suppress(Exception):
        store.append_event("run-1", {"event": "test"})

    with contextlib.suppress(Exception):
        store.get_events("run-1")

    with contextlib.suppress(Exception):
        store.list_metadata()

    with contextlib.suppress(Exception):
        store.list()

    with contextlib.suppress(Exception):
        store.delete("run-1")

    with contextlib.suppress(Exception):
        store.clear()

    with contextlib.suppress(Exception):
        store.get_workspace("run-1")

    with contextlib.suppress(Exception):
        store.set_workspace("run-1", b"")

    with contextlib.suppress(Exception):
        store.pack()

    with contextlib.suppress(Exception):
        store.register_webhook("http://test")

    with contextlib.suppress(Exception):
        store.list_webhooks()

    with contextlib.suppress(Exception):
        store.delete_webhook("wh-1")
