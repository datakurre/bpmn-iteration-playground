from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else context.new_page()
    page.on("requestfailed", lambda request: print(f"requestfailed:{request.url}:{request.failure}"))
    page.goto("http://localhost:8000/", wait_until="domcontentloaded")
    page.get_by_role("button", name="Start contract review").click()
    page.get_by_text("waiting_human", exact=True).wait_for(timeout=10000)
    page.locator("input[id$='decision']").fill("approved")
    page.locator("input[id$='notes']").fill("Host browser verification.")
    page.get_by_role("button", name="Submit review").click()
    page.get_by_text("completed", exact=True).wait_for(timeout=10000)
    page.screenshot(path="host-browser-workflow-completed.png", full_page=True)
    print(page.title())
    print(page.locator("body").aria_snapshot())
