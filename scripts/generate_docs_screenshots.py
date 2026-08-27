#!/usr/bin/env python3
"""Regenerate every screenshot referenced by ``docs/``.

Drives a real server through a full scenario -- an agent run, a revision loop, an approval,
a savepoint fork, and a Project spawning children -- then captures each panel the docs point
at. Run it with the app already up (``devenv up -d`` or ``make run``); ``make screenshots``
does exactly that.

Two things here are deliberate and easy to undo by accident:

* **``wait_until="load"``, never ``networkidle``.** The instance view holds a websocket open,
  so the network never goes idle and ``networkidle`` simply times out.
* **Screenshots go through raw CDP** (``Page.captureScreenshot``) rather than
  ``page.screenshot()``. Playwright's screenshot waits for a visually stable frame, and the
  same websocket repaints the page often enough that the wait never settles.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any

from playwright.sync_api import Page, sync_playwright

BASE_URL = os.environ.get("APP_URL", "http://127.0.0.1:8000")
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "docs" / "images"

# Freeze anything that could differ between two runs of the same scenario.
NO_ANIM = """*,*::before,*::after{animation:none!important;transition:none!important;
caret-color:transparent!important;scroll-behavior:auto!important}"""


# --------------------------------------------------------------------------- HTTP helpers


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req) as resp:
        raw = resp.read().decode()
    return json.loads(raw) if raw else None


def wait_for_server(timeout: int = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE_URL}/health", timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"Server at {BASE_URL} did not become ready within {timeout}s")


def wait_for_status(workflow_id: str, *statuses: str, timeout: int = 90) -> dict[str, Any]:
    deadline = time.time() + timeout
    state: dict[str, Any] = {}
    while time.time() < deadline:
        state = _request("GET", f"/instance/{workflow_id}/state")
        if state.get("status") in statuses:
            return state
        time.sleep(0.5)
    raise RuntimeError(f"{workflow_id} never reached {statuses}; last status {state.get('status')!r}")


def ready_task_id(state: dict[str, Any]) -> str:
    return next(t["id"] for t in state["tasks"] if t["state"] == "READY")


# ----------------------------------------------------------------------- capture helpers


class Shooter:
    def __init__(self, page: Page, cdp: Any) -> None:
        self.page = page
        self.cdp = cdp

    def go(self, path: str, *, width: int = 1600, height: int = 1000, settle: int = 3000) -> None:
        self.page.set_viewport_size({"width": width, "height": height})
        self.page.goto(f"{BASE_URL}{path}", wait_until="load", timeout=45000)
        self.page.wait_for_timeout(settle)
        self.page.add_style_tag(content=NO_ANIM)
        self.page.wait_for_timeout(400)

    def _capture(self, name: str, clip: dict[str, float] | None = None) -> None:
        params: dict[str, Any] = {"format": "png", "captureBeyondViewport": False}
        if clip is not None:
            params["clip"] = {**clip, "scale": 1}
        result = self.cdp.send("Page.captureScreenshot", params)
        (OUTPUT_DIR / name).write_bytes(base64.b64decode(result["data"]))
        print(f"   saved {name}")

    def page_shot(self, name: str) -> None:
        self._capture(name)

    def panel(self, name: str, selector: str, pad: int = 10) -> None:
        box = self.page.locator(selector).first.bounding_box()
        if box is None:
            raise RuntimeError(f"{selector} is not visible; cannot capture {name}")
        self._capture(
            name,
            {
                "x": max(0.0, box["x"] - pad),
                "y": max(0.0, box["y"] - pad),
                "width": box["width"] + 2 * pad,
                "height": box["height"] + 2 * pad,
            },
        )


# ------------------------------------------------------------------------------ scenario


def build_scenario() -> dict[str, str]:
    """Run the workflows the docs describe and return the instance ids to photograph."""
    print("Building scenario...")

    # A document_generation run, taken round the revision loop so the diagram shows iteration.
    looped = _request(
        "POST",
        "/workflow/start",
        {
            "bpmn_path": "graph_agent/data/workflows/document_generation.bpmn",
            "process_id": "document_generation",
            "variables": {"topic": "ZODB savepoints and workspace blobs in Pi Workflow Studio"},
        },
    )["workflow_id"]
    state = wait_for_status(looped, "waiting_human")
    _request(
        "POST",
        f"/instance/{looped}/submit-task/{ready_task_id(state)}",
        {
            "variables": {
                "document_content": "First draft.",
                "approval": "revise",
                "feedback": "Please add an architectural section on ZODB savepoints and on-demand workspace file streaming.",
            }
        },
    )
    wait_for_status(looped, "waiting_human")
    print(f"   revision-loop instance: {looped}")

    # A second run, forked from the savepoint taken after the drafting agent finished, then
    # approved -- this is the completed instance, and proves a fork keeps the agent's files.
    source = _request(
        "POST",
        "/workflow/start",
        {
            "bpmn_path": "graph_agent/data/workflows/document_generation.bpmn",
            "process_id": "document_generation",
            "variables": {"topic": "Savepoint retention and manual purge"},
        },
    )["workflow_id"]
    state = wait_for_status(source, "waiting_human")
    after_draft = next(sp for sp in state["save_points"] if sp["phase"] == "after_harness")["id"]
    forked = _request("POST", f"/instance/{source}/fork/{after_draft}", {"variables": {}})["workflow_id"]
    state = wait_for_status(forked, "waiting_human")
    _request(
        "POST",
        f"/instance/{forked}/submit-task/{ready_task_id(state)}",
        {
            "variables": {
                "document_content": (
                    "# ZODB Savepoints and Workspace Blobs\n\nSavepoints capture the workspace as an "
                    "independent ZODB Blob, so forking a run restores the agent files exactly as they were."
                ),
                "approval": "approved",
                "feedback": "",
            }
        },
    )
    wait_for_status(forked, "completed")
    print(f"   source instance: {source} -> completed fork: {forked}")

    # A Project, spawning one child per message while staying open.
    project = _request(
        "POST",
        "/workflow/start",
        {
            "bpmn_path": "graph_agent/data/workflows/project.bpmn",
            "process_id": "project",
            "variables": {"project_name": "Docs refresh"},
        },
    )["workflow_id"]
    time.sleep(2)
    for brief in (
        "Audit the docs tree against shipped features",
        "Refresh screenshots from the live UI",
        "Update the plans status table",
    ):
        _request("POST", f"/instance/{project}/message/spawn_requested", {"payload": {"task_brief": brief}})
        time.sleep(8)
    print(f"   project instance: {project}")

    return {"looped": looped, "source": source, "completed": forked, "project": project}


# ---------------------------------------------------------------------------------- main


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    wait_for_server()
    ids = build_scenario()

    print("Capturing screenshots...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )
        context = browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        page = context.new_page()
        shot = Shooter(page, context.new_cdp_session(page))

        shot.go("/")
        shot.page_shot("studio-dashboard.png")

        shot.go(f"/instance/{ids['looped']}")
        shot.page_shot("docgen-review-checkpoint.png")
        shot.page_shot("desktop-resizer-verified.png")
        shot.panel("instance-review-form.png", "#review-card")
        shot.panel("savepoint-inspector.png", "#savepoints")
        shot.panel("docgen-iteration-loop.png", "#canvas-container", pad=0)
        shot.panel("instance-workspace-files.png", "#workspace-files-card")

        shot.go(f"/instance/{ids['completed']}")
        shot.page_shot("instance-completed.png")
        shot.panel("savepoint-fork.png", "#savepoints")

        shot.go(f"/instance/{ids['source']}")
        shot.panel("savepoint-purge.png", "#savepoints")

        shot.go(f"/instance/{ids['project']}")
        shot.page_shot("project-spawn.png")

        shot.go("/history")
        shot.page_shot("process-history.png")

        shot.go("/admin")
        shot.page_shot("admin-management.png")

        shot.go("/editor", settle=6000)
        shot.page_shot("bpmn-editor.png")

        browser.close()

    print(f"\nAll documentation screenshots regenerated in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
