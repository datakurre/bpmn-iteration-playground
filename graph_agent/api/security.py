"""Origin/Host guard: blocks a page on another origin from driving this daemon.

A loopback web server with no cross-origin check is reachable from any page open in the
user's browser, not just this app's own tabs -- the browser happily sends the request,
same machine either way; only `Origin` distinguishes "this app's own page" from "whatever
page happens to be open". Comparing `Origin` against the request's own `Host` header needs
no foreknowledge of which port the daemon ended up bound to, so it works for any port
`bind_free_port` picked at start time.

Implemented as a raw ASGI middleware rather than Starlette's `BaseHTTPMiddleware`: that
helper only ever sees `http` scope, silently passing `websocket` straight through to the
app underneath -- which would leave `/ws/instance/{id}` unguarded, the same class of
request this exists to block.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class OriginHostGuardMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        origin = headers.get(b"origin")
        if origin:
            origin_host = urlsplit(origin.decode("latin-1")).netloc
            request_host = (headers.get(b"host") or b"").decode("latin-1")
            if origin_host and origin_host != request_host:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4403})
                else:
                    response = JSONResponse({"detail": "Cross-origin request blocked"}, status_code=403)
                    await response(scope, receive, send)
                return

        await self.app(scope, receive, send)
