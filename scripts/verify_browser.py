from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("console", lambda message: print(f"console:{message.type}:{message.text}"))
    page.on("pageerror", lambda error: print(f"pageerror:{error}"))
    page.goto("http://127.0.0.1:8000/", wait_until="networkidle")
    page.screenshot(path="browser-dashboard-start.png", full_page=True)
    page.get_by_role("button", name="Start contract review").click()
    page.get_by_text("waiting_human", exact=True).wait_for(timeout=10000)
    page.screenshot(path="browser-dashboard-human-review.png", full_page=True)
    page.locator("input[data-field='decision']").fill("approved")
    page.locator("input[data-field='notes']").fill("Demo review completed in the browser.")
    page.get_by_role("button", name="Complete review").click()
    page.get_by_text("completed", exact=True).wait_for(timeout=10000)
    page.screenshot(path="browser-dashboard-completed.png", full_page=True)
    print(page.locator("body").aria_snapshot())
    browser.close()
