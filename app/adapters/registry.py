from __future__ import annotations

from typing import Dict, List, Optional

from app.adapters.base import BaseAdapter
from app.adapters.pi_adapter import PiAdapter


class AdapterRegistry:
    """Registry managing pluggable agent adapters keyed by harness_type."""

    def __init__(self) -> None:
        self._adapters: Dict[str, BaseAdapter] = {}
        # Register default Pi adapter
        self.register(PiAdapter())

    def register(self, adapter: BaseAdapter) -> None:
        self._adapters[adapter.adapter_type] = adapter

    def get(self, harness_type: str) -> Optional[BaseAdapter]:
        return self._adapters.get(harness_type)

    def list_types(self) -> List[str]:
        return list(self._adapters.keys())
