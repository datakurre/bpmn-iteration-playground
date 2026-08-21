from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto("http://127.0.0.1:8000/", wait_until="networkidle")
    page.get_by_role("button", name="Start contract review").click()
    page.wait_for_url("**/instance/*")
    retry = page.get_by_role("button", name="Retry")
    retry.wait_for(timeout=10000)
    assert "failure_reason" in page.locator("#data").inner_text()
    retry.click()
    retry.wait_for(timeout=10000)
    print("verified explicit retry button and descriptive failure state")
    browser.close()
