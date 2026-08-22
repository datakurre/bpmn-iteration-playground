import importlib.metadata
import importlib.util
import inspect
import logging
import os
from pathlib import Path

from app.adapters.base import BaseAdapter
from app.adapters.pi_adapter import PiAdapter
from app.adapters.sandbox_adapter import SandboxPiAdapter
from app.adapters.shell_adapter import ShellAdapter

logger = logging.getLogger("bpmn.adapters")


class AdapterRegistry:
    """Registry managing pluggable agent adapters keyed by harness_type."""

    def __init__(self, auto_discover: bool = True) -> None:
        self._adapters: dict[str, BaseAdapter] = {}
        # Register default Pi adapter, Sandbox adapter and the deterministic Shell adapter
        pi_adapter = PiAdapter()
        sandbox_adapter = SandboxPiAdapter()
        self.register(pi_adapter)
        self.register(sandbox_adapter)
        self.register(ShellAdapter())
        # Register alias for agent_sandbox
        self._adapters["agent_sandbox"] = sandbox_adapter

        if os.getenv("PI_SANDBOX_ENABLED") == "1":
            self._adapters["pi_agent"] = sandbox_adapter

        if auto_discover:
            self.discover_plugins()

    def register(self, adapter: BaseAdapter) -> None:
        self._adapters[adapter.adapter_type] = adapter

    def get(self, harness_type: str) -> BaseAdapter | None:
        return self._adapters.get(harness_type)

    def list_types(self) -> list[str]:
        return list(self._adapters.keys())

    def discover_plugins(self) -> int:
        """Discover adapters via entry points and ADAPTER_PLUGINS directory."""
        discovered = 0
        # 1. Entry points discovery
        try:
            eps = importlib.metadata.entry_points(group="bpmn_adapters")
            for ep in eps:
                try:
                    cls = ep.load()
                    if inspect.isclass(cls) and issubclass(cls, BaseAdapter) and cls is not BaseAdapter:
                        self.register(cls())
                        discovered += 1
                        logger.info(f"Discovered adapter plugin via entry points: {cls.__name__}")
                except Exception as exc:
                    logger.warning(f"Failed to load entry point adapter {ep.name}: {exc}")
        except Exception:
            pass

        # 2. Directory discovery via ADAPTER_PLUGINS env var
        plugins_dir = os.getenv("ADAPTER_PLUGINS")
        if plugins_dir:
            p = Path(plugins_dir)
            if p.is_dir():
                for py_file in p.glob("*.py"):
                    if py_file.name.startswith("__"):
                        continue
                    try:
                        spec = importlib.util.spec_from_file_location(py_file.stem, py_file)
                        if spec and spec.loader:
                            module = importlib.util.module_from_spec(spec)
                            spec.loader.exec_module(module)
                            for attr_name in dir(module):
                                attr = getattr(module, attr_name)
                                if (
                                    inspect.isclass(attr)
                                    and issubclass(attr, BaseAdapter)
                                    and attr not in (BaseAdapter, PiAdapter)
                                ):
                                    self.register(attr())
                                    discovered += 1
                                    logger.info(f"Discovered adapter plugin from {py_file.name}: {attr.__name__}")
                    except Exception as exc:
                        logger.warning(f"Failed to load adapter plugin from {py_file}: {exc}")

        return discovered
