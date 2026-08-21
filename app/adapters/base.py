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
    session_id: str | None = None
    network: dict[str, Any] | None = None
    policy_error: str | None = None


class BaseAdapter(ABC):
    """Abstract base class for AI agent and execution backends."""

    @abstractmethod
    async def run(
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
        on_event: Any = None,
    ) -> AgentResult:
        """Execute an agent task with the given prompt, configuration, and event callback."""
        ...

    async def prepare_workspace(self, workdir: str, config: dict[str, str]) -> None:
        """Optional hook: lay down harness-specific files before the turn runs.

        Called with the instance workspace the agent will execute in. The default is a
        no-op; adapters that need configuration on disk (sandbox policy, tool config)
        write it here instead of the orchestrator doing it on their behalf.
        """
        return None

    @property
    @abstractmethod
    def adapter_type(self) -> str:
        """Return the harness_type identifier this adapter handles (e.g. 'pi_agent')."""
        ...
