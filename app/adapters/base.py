from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class AdapterCapabilities:
    """What the orchestrator needs to know about a harness without naming it.

    Every field here exists because `workflow_service` used to answer the question with
    `if harness_type == "pi_agent"`. A harness declares its own nature; orchestration
    reads the declaration. Defaults describe the most conservative harness -- no session
    continuity, no special diagnostics -- so an adapter only states what is unusual
    about it, and a third-party plugin that declares nothing still behaves sanely.
    """

    display_name: str
    supports_sessions: bool = False
    """Whether turns carry conversational state that must be threaded and forked.

    True for LLM harnesses. A deterministic build step has nothing to continue, and
    letting it hold a session id makes it collide with real agent turns (see
    `_dispatch`'s sibling check).
    """

    consumes_prompt: bool = True
    """Whether `run()` reads the generated prompt at all. `ShellAdapter` does not."""

    timeout_env_var: str | None = None
    default_timeout_seconds: float = 900.0
    no_output_hint: str | None = None
    """Extra diagnosis appended when a turn exits cleanly but produced no result."""

    view: str = "agent"
    """Which UI renders a turn: `agent` for a message stream, `console` for a log tail."""


def resolve_timeout(capabilities: AdapterCapabilities) -> float:
    """This harness's default timeout, from its declared env var if one is set."""
    raw = os.getenv(capabilities.timeout_env_var) if capabilities.timeout_env_var else None
    if not raw:
        return capabilities.default_timeout_seconds
    try:
        return float(raw)
    except (TypeError, ValueError):
        return capabilities.default_timeout_seconds


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

    @property
    def capabilities(self) -> AdapterCapabilities:
        """Declare what this harness is, so orchestration need not special-case it.

        Deliberately concrete rather than abstract: adapters predating this surface, and
        third-party plugins, keep working as the conservative default.
        """
        return AdapterCapabilities(display_name=self.adapter_type)
