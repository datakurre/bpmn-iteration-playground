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

    async def run(
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
        on_event: Any = None,
    ) -> AgentResult:
        provider = config.get("provider") or config.get("pi_provider")
        model = config.get("model") or config.get("pi_model")
        timeout_raw = config.get("timeout") or config.get("timeout_seconds")
        timeout_seconds = int(timeout_raw) if timeout_raw and timeout_raw.isdigit() else None

        result: PiResult = await self.client.run(
            prompt,
            cwd,
            on_event=on_event,
            provider=provider,
            model=model,
            timeout_seconds=timeout_seconds,
        )
        return AgentResult(
            status=result.status,
            output=result.output,
            text=result.text,
            messages=result.messages,
            stderr=result.stderr,
            exit_code=result.exit_code,
        )
