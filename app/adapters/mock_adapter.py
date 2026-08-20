from __future__ import annotations

from typing import Any

from app.adapters.base import AgentResult, BaseAdapter


class MockAdapter(BaseAdapter):
    """Deterministic mock adapter for fast testing without invoking external subprocesses."""

    def __init__(self, status: str = "success", output: dict[str, Any] | None = None) -> None:
        self.status = status
        self.output = output if output is not None else {
            "status": "success",
            "summary": "Mock execution completed successfully",
            "findings": [],
            "artifacts": [],
            "next_action": "continue",
        }
        self.calls = 0

    @property
    def adapter_type(self) -> str:
        return "mock_agent"

    async def run(
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
        on_event: Any = None,
    ) -> AgentResult:
        self.calls += 1
        if on_event and callable(on_event):
            try:
                import asyncio
                res = on_event({"type": "message_end", "content": "mock event"})
                if asyncio.iscoroutine(res):
                    await res
            except Exception:
                pass
        return AgentResult(
            status=self.status,
            output=dict(self.output),
            text="Mock agent execution result",
            messages=[],
            stderr="",
            exit_code=0 if self.status == "success" else 1,
        )
