from pathlib import Path

from fastapi.templating import Jinja2Templates
from starlette.requests import Request
from starlette.responses import Response

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


def _ensure_request(request: Request | None) -> Request:
    if request is None:
        return Request({"type": "http", "headers": []})
    return request


def page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "dashboard.html")


def instance_page(request: Request | str | None = None, workflow_id: str = "") -> Response:
    if isinstance(request, str):
        workflow_id = request
        request = None
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "instance.html", {"workflow_id": workflow_id})


def history_page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "history.html")


def history_detail_page(request: Request | str | None = None, workflow_id: str = "") -> Response:
    if isinstance(request, str):
        workflow_id = request
        request = None
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "history_detail.html", {"workflow_id": workflow_id})


def admin_page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "admin.html")


def editor_page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "editor.html")

