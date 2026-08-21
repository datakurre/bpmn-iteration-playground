import pytest
from app.adapters.mock_adapter import MockAdapter


@pytest.mark.anyio
async def test_mock_adapter_empty_dict_output() -> None:
    adapter = MockAdapter(status="success", output={})
    res = await adapter.run("prompt", {}, "/tmp")
    assert res.output == {}
    assert res.output != {
        "status": "success",
        "summary": "Mock execution completed successfully",
        "findings": [],
        "artifacts": [],
        "next_action": "continue",
    }


def test_adapter_plugin_discovery_from_dir(tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.adapters.registry import AdapterRegistry
    plugin_dir = str(tmp_path)
    plugin_file = tmp_path / "custom_adapter.py"
    plugin_file.write_text(
        """from app.adapters.base import BaseAdapter, AgentResult

class MyCustomPluginAdapter(BaseAdapter):
    @property
    def adapter_type(self) -> str:
        return "custom_plugin"

    async def run(self, prompt, config, cwd, on_event=None):
        return AgentResult("success", {"status": "success"}, "ok")
"""
    )
    monkeypatch.setenv("ADAPTER_PLUGINS", plugin_dir)
    reg = AdapterRegistry(auto_discover=True)
    assert "custom_plugin" in reg.list_types()
    adapter = reg.get("custom_plugin")
    assert adapter is not None
    assert adapter.adapter_type == "custom_plugin"


@pytest.mark.anyio
async def test_mock_adapter_calls_sync_on_event() -> None:
    adapter = MockAdapter()
    received = []
    res = await adapter.run("prompt", {}, "/tmp", on_event=lambda ev: received.append(ev))
    assert received == [{"type": "message_end", "content": "mock event"}]
    assert res.status == "success"


@pytest.mark.anyio
async def test_mock_adapter_awaits_async_on_event() -> None:
    adapter = MockAdapter()
    received = []

    async def on_event(ev):
        received.append(ev)

    await adapter.run("prompt", {}, "/tmp", on_event=on_event)
    assert received == [{"type": "message_end", "content": "mock event"}]


@pytest.mark.anyio
async def test_mock_adapter_swallows_on_event_errors() -> None:
    adapter = MockAdapter()

    def failing_on_event(ev):
        raise RuntimeError("boom")

    res = await adapter.run("prompt", {}, "/tmp", on_event=failing_on_event)
    assert res.status == "success"


@pytest.mark.anyio
async def test_mock_adapter_ignores_non_callable_on_event() -> None:
    adapter = MockAdapter()
    res = await adapter.run("prompt", {}, "/tmp", on_event="not-callable")
    assert res.status == "success"


@pytest.mark.anyio
async def test_mock_adapter_failure_status_sets_nonzero_exit_code() -> None:
    adapter = MockAdapter(status="failed")
    res = await adapter.run("prompt", {}, "/tmp")
    assert res.exit_code == 1
