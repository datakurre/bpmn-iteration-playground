"""A thin httpx client for CLI verbs to talk to a running `bpmn serve` daemon.

Phase 4 of the meta-agent refactor (docs/meta-agent-refactor-plan.md): `bpmn run/ls/show/
cancel/logs` are all a second `bpmn` invocation making HTTP calls against the daemon a
first invocation started -- this module is the one place that knows the wire shape (base
URL, the `X-Admin-Token` header from `.agents/runtime.json`, endpoint paths), so the CLI
verbs themselves stay thin argument-parsing-and-printing code.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any, cast

import httpx

from bpmn_agent.agents_root import Workspace
from bpmn_agent.daemon import RuntimeInfo, is_daemon_alive, read_runtime_file


class DaemonNotRunningError(RuntimeError):
    """No live daemon for this workspace. A CLI verb catches this to print "run `bpmn
    serve` first" instead of an httpx connection traceback."""


class DaemonRequestError(RuntimeError):
    """The daemon responded, but with an error status. Carries the parsed body so a CLI
    verb can print the same message the API returned rather than a bare status code."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"{status_code}: {detail}")


def require_running_daemon(workspace: Workspace) -> RuntimeInfo:
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        raise DaemonNotRunningError(f"No daemon running for {workspace.root}. Run `bpmn serve` first.")
    return info


def _detail_from_response(status_code: int, text: str) -> DaemonRequestError:
    try:
        parsed = json.loads(text)
        detail = parsed.get("detail", text) if isinstance(parsed, dict) else text
    except ValueError:
        detail = text
    return DaemonRequestError(status_code, detail)


class DaemonClient:
    """One HTTP connection to a workspace's running daemon.

    Construct with `for_workspace` from a CLI verb, which also resolves and validates
    `.agents/runtime.json`; the raw constructor is for tests that already have a
    `RuntimeInfo` (e.g. one built against an in-process `TestClient`'s own base URL).
    """

    def __init__(
        self,
        info: RuntimeInfo,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # `transport` is a test-only seam (an httpx.ASGITransport wrapping the FastAPI app
        # directly, no real socket) -- every real CLI verb call goes through `for_workspace`
        # and leaves it unset, so a genuine daemon always gets httpx's normal network
        # transport.
        self.info = info
        self._client = httpx.AsyncClient(
            base_url=info.url,
            headers={"X-Admin-Token": info.token},
            timeout=timeout,
            transport=transport,
        )

    @classmethod
    def for_workspace(cls, workspace: Workspace, timeout: float = 30.0) -> DaemonClient:
        return cls(require_running_daemon(workspace), timeout=timeout)

    async def __aenter__(self) -> DaemonClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self._client.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise _detail_from_response(response.status_code, response.text)
        return response.json()

    async def start(
        self,
        bpmn_path: str,
        process_id: str | None = None,
        variables: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"bpmn_path": bpmn_path, "variables": variables or {}}
        if process_id is not None:
            body["process_id"] = process_id
        return cast(dict[str, Any], await self._request("POST", "/workflow/start", json=body))

    async def list_instances(
        self,
        status: str | None = None,
        limit: int | None = None,
        offset: int = 0,
        since: str | None = None,
        until: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"offset": offset}
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        if since is not None:
            params["since"] = since
        if until is not None:
            params["until"] = until
        return cast(list[dict[str, Any]], await self._request("GET", "/api/history/instances", params=params))

    async def state(self, workflow_id: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self._request("GET", f"/instance/{workflow_id}/state"))

    async def cancel(self, workflow_id: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self._request("POST", f"/instance/{workflow_id}/cancel"))

    async def merge(self, workflow_id: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self._request("POST", f"/instance/{workflow_id}/merge"))

    async def stream_events(self, workflow_id: str) -> AsyncIterator[dict[str, Any]]:
        """Yield each `state()`-shaped payload the daemon's SSE stream sends, in order,
        until the stream ends -- the daemon closes it once the instance reaches a terminal
        status, or after its own ~30s cap (see instance.py's sse_events_stream).
        """
        async with self._client.stream("GET", f"/instance/{workflow_id}/events/stream") as response:
            if response.status_code >= 400:
                body = await response.aread()
                raise _detail_from_response(response.status_code, body.decode(errors="replace"))
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    yield json.loads(line[len("data: ") :])
