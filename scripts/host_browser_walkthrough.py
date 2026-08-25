import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("APP_URL", "http://localhost:8000")
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "docs" / "images"
CDP_URL = "http://127.0.0.1:9222"

def main():  # noqa: PLR0915 -- linear step-by-step manual walkthrough script; splitting it up would obscure the sequence it demonstrates
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Connecting to Host Browser over CDP at {CDP_URL}...")

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP_URL)
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.new_page()
        page.set_viewport_size({"width": 1440, "height": 900})

        errors = []
        page.on("console", lambda msg: print(f"[Browser Console {msg.type}] {msg.text}"))
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("requestfailed", lambda req: print(f"[Browser Request Failed] {req.url}: {req.failure}"))

        # Step 1: Studio Dashboard
        print("1. Navigating to Studio Dashboard...")
        page.goto(f"{BASE_URL}/", wait_until="domcontentloaded")
        page.wait_for_selector("#start")
        page.wait_for_timeout(1000)

        # Select Contract Review template
        print("   Selecting 'Contract Review' workflow template...")
        page.locator("#template-select").select_option("bpmn_agent/data/workflows/contract_review.bpmn")

        contract_text = (
            "Enterprise Master Services Agreement (MSA) between Acme Cloud Corp and Beta Tech Inc.\n"
            "Section 4: Confidentiality obligation shall survive for 5 years.\n"
            "Section 9: Limitation of Liability is capped at 2x annual recurring revenue (ARR).\n"
            "Section 12: Compliance with GDPR and EU data protection standard contractual clauses."
        )
        page.locator("#contract").fill(contract_text)
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUTPUT_DIR / "studio-dashboard.png"), full_page=False)
        print(f"   Saved {OUTPUT_DIR / 'studio-dashboard.png'}")

        # Step 2: Launch Process
        print("2. Starting real AI workflow process with Zen API (gpt-5.6-luna)...")
        page.locator("#start").click()

        print("   Waiting for instance to load and Pi agent task to execute...")
        page.wait_for_timeout(2000)
        current_url = page.url
        print(f"   Current URL: {current_url}")

        if "/instance/" not in current_url:
            instance_link = page.locator("a[href^='/instance/']").first
            instance_link.wait_for(timeout=10000)
            instance_link.click()
            page.wait_for_load_state("domcontentloaded")
            current_url = page.url
            print(f"   Navigated to: {current_url}")

        # Wait for Pi agent task to complete and human review form to appear
        print("   Waiting for Pi task completion -> 'waiting_human' state...")
        page.get_by_text("waiting_human", exact=True).wait_for(timeout=60000)
        page.wait_for_timeout(2000)

        # Step 3: Screenshot Live Instance Review Form
        print("3. Capturing Live Instance with BPMN Diagram & Human Review Form...")
        page.screenshot(path=str(OUTPUT_DIR / "instance-review-form.png"), full_page=False)
        print(f"   Saved {OUTPUT_DIR / 'instance-review-form.png'}")

        # Step 4: Submit Human Review Decision
        print("4. Filling and submitting Human Review Form (FormJS)...")
        page.locator("input[id$='decision']").fill("approved")
        page.locator("input[id$='notes']").fill("Approved: GDPR compliance and 2x ARR liability caps verified from contract.")
        page.locator("#submit").click()

        print("   Waiting for workflow state -> 'completed'...")
        page.get_by_text("completed", exact=True).wait_for(timeout=20000)
        page.wait_for_timeout(2000)
        page.screenshot(path=str(OUTPUT_DIR / "instance-completed.png"), full_page=False)
        print(f"   Saved {OUTPUT_DIR / 'instance-completed.png'}")

        # Step 5: Savepoints and Forking
        print("5. Inspecting Savepoints and testing Forking...")
        fork_buttons = page.locator("button:has-text('Fork')")
        if fork_buttons.count() > 0:
            print("   Found Savepoint Fork button. Forking timeline branch...")
            fork_buttons.first.click()
            page.wait_for_timeout(2500)
            page.screenshot(path=str(OUTPUT_DIR / "savepoint-fork.png"), full_page=False)
            print(f"   Saved {OUTPUT_DIR / 'savepoint-fork.png'}")

        # Step 6: Process History & Analytics
        print("6. Navigating to Process History...")
        page.goto(f"{BASE_URL}/history", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUTPUT_DIR / "process-history.png"), full_page=False)
        print(f"   Saved {OUTPUT_DIR / 'process-history.png'}")

        # Step 7: History Detail / Savepoint Inspector
        history_links = page.locator("a[href^='/history/']")
        if history_links.count() > 0:
            print("7. Navigating to History Detail / Savepoint Inspector...")
            history_links.first.click()
            page.wait_for_load_state("domcontentloaded")
            page.wait_for_timeout(2000)
            page.screenshot(path=str(OUTPUT_DIR / "savepoint-inspector.png"), full_page=False)
            print(f"   Saved {OUTPUT_DIR / 'savepoint-inspector.png'}")

        # Step 8: BPMN Modeler / Editor
        print("8. Navigating to BPMN Editor...")
        page.goto(f"{BASE_URL}/editor", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUTPUT_DIR / "bpmn-editor.png"), full_page=False)
        print(f"   Saved {OUTPUT_DIR / 'bpmn-editor.png'}")

        # Step 9: Admin & Storage Page
        print("9. Navigating to Admin Management...")
        page.goto(f"{BASE_URL}/admin", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUTPUT_DIR / "admin-management.png"), full_page=False)
        print(f"   Saved {OUTPUT_DIR / 'admin-management.png'}")

        if errors:
            print(f"WARNING: Browser recorded errors: {errors}")
        else:
            print("SUCCESS: Full host browser walkthrough completed with zero page errors!")

if __name__ == "__main__":
    main()
