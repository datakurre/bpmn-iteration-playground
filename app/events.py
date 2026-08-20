from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger("bpmn.events")


@dataclass
class WorkflowEvent:
    event_type: str
    workflow_id: str
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    task_id: str | None = None
    task_name: str | None = None
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class EventBus:
    """Internal event bus that persists workflow events and asynchronously delivers webhooks."""

    def __init__(self, store: Any = None) -> None:
        self.store = store
        self._pending_tasks: set[asyncio.Task[Any]] = set()

    def emit(
        self,
        event_type: str,
        workflow_id: str,
        task_id: str | None = None,
        task_name: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> WorkflowEvent:
        event = WorkflowEvent(
            event_type=event_type,
            workflow_id=workflow_id,
            task_id=task_id,
            task_name=task_name,
            data=dict(data or {}),
        )

        if self.store is not None and hasattr(self.store, "append_event"):
            try:
                self.store.append_event(workflow_id, event.to_dict())
            except Exception as exc:
                logger.warning(f"Failed to persist event {event_type} for {workflow_id}: {exc}")

        if self.store is not None and hasattr(self.store, "list_webhooks"):
            try:
                webhooks = self.store.list_webhooks()
                for wh in webhooks:
                    wh_events = wh.get("events")
                    if not wh_events or event_type in wh_events:
                        wh_secret = wh.get("secret")
                        task = asyncio.create_task(self._deliver_webhook(wh["url"], event, secret=wh_secret))
                        self._pending_tasks.add(task)
                        task.add_done_callback(self._pending_tasks.discard)
            except Exception as exc:
                logger.warning(f"Failed to dispatch webhooks for {event_type}: {exc}")

        return event

    async def _deliver_webhook(
        self,
        url: str,
        event: WorkflowEvent,
        retries: int = 3,
        secret: str | None = None,
    ) -> bool:
        import hashlib
        import hmac
        import json
        import os

        payload_bytes = json.dumps(event.to_dict(), sort_keys=True).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        effective_secret = secret or os.getenv("WEBHOOK_SECRET")
        if effective_secret:
            sig = hmac.new(effective_secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
            headers["X-Webhook-Signature"] = f"sha256={sig}"

        async with httpx.AsyncClient() as client:
            for attempt in range(retries):
                try:
                    resp = await client.post(url, content=payload_bytes, headers=headers, timeout=10.0)
                    if resp.status_code < 400:
                        return True
                except Exception as exc:
                    logger.debug(f"Webhook delivery attempt {attempt + 1} to {url} failed: {exc}")
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt)
            return False
