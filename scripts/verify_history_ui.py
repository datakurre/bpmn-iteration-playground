from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else context.new_page()
    page.goto("http://127.0.0.1:8000/history", wait_until="domcontentloaded")
    page.wait_for_selector(".card", timeout=5000)
    print("Page Title:", page.title())
    print("Card Count:", page.locator(".card").count())
    page.locator("button[data-filter='completed']").click()
    page.wait_for_timeout(500)
    page.screenshot(path="history-page-verification.png", timeout=5000)
    print("Screenshot saved successfully!")
