from __future__ import annotations

from typing import Any

from app.adapters.base import AgentResult, BaseAdapter
from app.pi_rpc import PiResult, PiRpcClient


class PiAdapter(BaseAdapter):
    """Adapter invoking local Pi AI agents via JSONL RPC."""

    def __init__(self, client: PiRpcClient | None = None, **kwargs: Any) -> None:
        self.client = client or PiRpcClient(**kwargs)

    @property
    def adapter_type(self) -> str:
        return "pi_agent"

    async def run(self, prompt: str, config: dict[str, str], cwd: str) -> AgentResult:
        result: PiResult = await self.client.run(prompt, cwd)
        return AgentResult(
            status=result.status,
            output=result.output,
            text=result.text,
            messages=result.messages,
            stderr=result.stderr,
            exit_code=result.exit_code,
        )
