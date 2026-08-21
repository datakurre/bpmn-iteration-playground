#!/usr/bin/env python3
"""
Automated headless screenshot generator for BPMN Pi Workflow documentation.
Uses Playwright in headless mode to capture high-resolution screenshots of all features:
- Studio Dashboard
- Live Instance Diagram & Human Review Form
- Savepoint Timeline & Forking
- Process History & Metrics
- Savepoint & Variable Inspector
"""

import json
import os
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("APP_URL", "http://127.0.0.1:8000")
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "docs" / "images"


def wait_for_server(url: str, timeout: int = 30) -> None:
    print(f"Waiting for {url} to be ready...")
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=2) as resp:
                if resp.status == 200:
                    print("Backend is ready!")
                    return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"Server at {url} did not become ready within {timeout}s")


def post_json(url: str, data: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    wait_for_server(BASE_URL)

    print("Launching headless Chromium for documentation screenshots...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        page = context.new_page()

        # 1. Studio Dashboard
        print("1. Capturing Studio Dashboard...")
        page.goto(f"{BASE_URL}/", wait_until="networkidle")
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUTPUT_DIR / "studio-dashboard.png"))
        print(f"   Saved {OUTPUT_DIR / 'studio-dashboard.png'}")

        # 2. Start a workflow to capture Live Instance with BPMN diagram & FormJS
        print("2. Starting workflow instance for live review...")
        start_result = post_json(f"{BASE_URL}/workflow/start", {
            "bpmn_path": "workflows/contract_review.bpmn",
            "variables": {
                "contract": "Enterprise Master Services Agreement (MSA) containing standard SLA, liability caps, and compliance terms."
            }
        })
        workflow_id = start_result["workflow_id"]
        print(f"   Workflow started: {workflow_id}")

        # Wait for Pi agent task to settle to waiting_human state
        for _ in range(30):
            with urllib.request.urlopen(f"{BASE_URL}/instance/{workflow_id}/state") as r:
                state = json.loads(r.read().decode("utf-8"))
                if state.get("status") == "waiting_human":
                    break
            time.sleep(0.5)

        # Navigate to instance view
        page.goto(f"{BASE_URL}/instance/{workflow_id}", wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUTPUT_DIR / "instance-review-form.png"))
        print(f"   Saved {OUTPUT_DIR / 'instance-review-form.png'}")

        # 3. Complete the human task to capture completed state
        print("3. Completing human task and capturing completed instance...")
        review_task = next(t for t in state["tasks"] if t["bpmn_id"] == "ServiceTask_Review")
        post_json(f"{BASE_URL}/instance/{workflow_id}/submit-task/{review_task['id']}", {
            "variables": {
                "decision": "approved",
                "notes": "Reviewed and approved according to legal guidelines."
            }
        })
        time.sleep(1)

        page.goto(f"{BASE_URL}/instance/{workflow_id}", wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUTPUT_DIR / "instance-completed.png"))
        print(f"   Saved {OUTPUT_DIR / 'instance-completed.png'}")

        # 4. Fork from savepoint to showcase branching
        print("4. Forking intermediate savepoint...")
        savepoints = state.get("save_points", [])
        if savepoints:
            fork_sp = savepoints[0]["id"]
            fork_result = post_json(f"{BASE_URL}/instance/{workflow_id}/fork/{fork_sp}", {
                "variables": {"contract": "Forked amended contract review branch."}
            })
            forked_id = fork_result["workflow_id"]
            time.sleep(1)
            page.goto(f"{BASE_URL}/instance/{forked_id}", wait_until="networkidle")
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUTPUT_DIR / "savepoint-fork.png"))
            print(f"   Saved {OUTPUT_DIR / 'savepoint-fork.png'}")

        # 5. Process History & Metrics Page
        print("5. Capturing Process History page...")
        page.goto(f"{BASE_URL}/history", wait_until="networkidle")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUTPUT_DIR / "process-history.png"))
        print(f"   Saved {OUTPUT_DIR / 'process-history.png'}")

        # 6. Save Point & Variable Inspector
        print("6. Capturing Save Point & Variable Inspector...")
        page.goto(f"{BASE_URL}/history/{workflow_id}", wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUTPUT_DIR / "savepoint-inspector.png"))
        print(f"   Saved {OUTPUT_DIR / 'savepoint-inspector.png'}")

        browser.close()
        print("\nAll documentation screenshots successfully generated in docs/images/!")


if __name__ == "__main__":
    main()
