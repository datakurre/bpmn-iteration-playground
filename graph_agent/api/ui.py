from pathlib import Path

from fastapi.templating import Jinja2Templates
from starlette.requests import Request
from starlette.responses import Response

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))


def _ensure_request(request: Request | None) -> Request:
    if request is None:
        return Request({"type": "http", "headers": [], "query_string": b""})
    return request


def _is_dev_mode(request: Request) -> bool:
    try:
        dev_param = request.query_params.get("dev")
        if dev_param is not None:
            return dev_param.lower() in ("1", "true", "yes", "on")
        return request.cookies.get("dev_mode") == "1"
    except (KeyError, AttributeError):
        return False


def page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "dashboard.html", {"dev_mode": _is_dev_mode(req)})


def instance_page(request: Request | str | None = None, workflow_id: str = "") -> Response:
    if isinstance(request, str):
        workflow_id = request
        request = None
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "instance.html", {"workflow_id": workflow_id, "dev_mode": _is_dev_mode(req)})


def history_page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "history.html", {"dev_mode": _is_dev_mode(req)})


def history_detail_page(request: Request | str | None = None, workflow_id: str = "") -> Response:
    if isinstance(request, str):
        workflow_id = request
        request = None
    req = _ensure_request(request)
    return templates.TemplateResponse(
        req, "history_detail.html", {"workflow_id": workflow_id, "dev_mode": _is_dev_mode(req)}
    )


def admin_page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "admin.html", {"dev_mode": _is_dev_mode(req)})


def editor_page(request: Request | None = None) -> Response:
    req = _ensure_request(request)
    return templates.TemplateResponse(req, "editor.html", {"dev_mode": _is_dev_mode(req)})
