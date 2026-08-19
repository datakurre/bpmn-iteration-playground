from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentResult:
    status: str  # "success" | "failed" | "timeout"
    output: dict[str, Any] | None
    text: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    stderr: str = ""
    exit_code: int | None = 0


class BaseAdapter(ABC):
    """Abstract base class for AI agent and execution backends."""

    @abstractmethod
    async def run(self, prompt: str, config: dict[str, str], cwd: str) -> AgentResult:
        """Execute an agent task with the given prompt and task configuration."""
        ...

    @property
    @abstractmethod
    def adapter_type(self) -> str:
        """Return the harness_type identifier this adapter handles (e.g. 'pi_agent')."""
        ...
