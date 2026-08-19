from __future__ import annotations

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("bpmn.http")


class JsonFormatter(logging.Formatter):
    """Structured JSON formatter for application logs."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Include standard correlation & extra fields if present
        for key in (
            "workflow_id",
            "task_id",
            "task_name",
            "status",
            "bpmn_path",
            "process_id",
            "duration_ms",
            "failure_reason",
            "exit_code",
            "method",
            "path",
            "status_code",
        ):
            if hasattr(record, key):
                log_entry[key] = getattr(record, key)

        if record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_entry, default=str)


def configure_logging(level: str = "INFO", log_file: str | None = None) -> None:
    """Configure root logger with structured JSON formatting and file output."""
    if log_file is None:
        log_file = os.getenv("LOG_FILE", "app.log")

    formatter = JsonFormatter()
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Remove existing handlers to avoid duplicate log lines
    root.handlers.clear()
    root.addHandler(stream_handler)

    if log_file:
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

    # Suppress verbose third-party logs
    logging.getLogger("ZODB").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """FastAPI/Starlette middleware logging incoming HTTP requests with latency."""

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        start_time = time.monotonic()
        response = await call_next(request)
        duration_ms = round((time.monotonic() - start_time) * 1000, 2)

        # Log requests (skip noisy static asset logs if desired, or log all)
        if not request.url.path.startswith("/static/"):
            logger.info(
                f"{request.method} {request.url.path} {response.status_code} ({duration_ms}ms)",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": response.status_code,
                    "duration_ms": duration_ms,
                },
            )
        return response
