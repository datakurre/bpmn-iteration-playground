import time

from playwright.sync_api import sync_playwright


def main():
    print("Starting Playwright...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        )
        page = browser.new_page(viewport={'width': 1280, 'height': 800})

        print("Navigating to Homepage...")
        page.goto('http://127.0.0.1:8000', wait_until='networkidle')
        time.sleep(1)
        page.screenshot(path='homepage_verification.png', full_page=True)
        print("Saved homepage_verification.png")

        print("Navigating to Admin...")
        page.goto('http://127.0.0.1:8000/admin', wait_until='networkidle')
        time.sleep(1)
        page.screenshot(path='admin_verification.png', full_page=True)
        print("Saved admin_verification.png")

        # Also start a process to capture instance page with form-js
        print("Starting process via API to inspect Instance Page...")
        res = page.evaluate("""async () => {
            const r = await fetch('/workflow/start', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({
                    bpmn_path: 'workflows/contract_review.bpmn',
                    variables: { contract: 'Test contract visual verification.' }
                })
            });
            return await r.json();
        }""")
        workflow_id = res.get("workflow_id")
        print(f"Started workflow: {workflow_id}")

        if workflow_id:
            page.goto(f'http://127.0.0.1:8000/instance/{workflow_id}', wait_until='networkidle')
            time.sleep(2)
            page.screenshot(path='instance_verification.png', full_page=True)
            print("Saved instance_verification.png")

        browser.close()
        print("Screenshots captured successfully!")

if __name__ == "__main__":
    main()
