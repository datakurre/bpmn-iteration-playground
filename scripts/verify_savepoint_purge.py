from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:8000/", wait_until="domcontentloaded")
    # /api/templates repopulates #template-select asynchronously and can reorder it, so pin
    # the workflow explicitly instead of relying on the option order at click time.
    page.select_option("#template-select", "workflows/contract_review.bpmn")
    page.fill("#contract", "Review this agreement for compliance.")
    page.click("#start")
    page.wait_for_url("**/instance/*")
    page.locator("button[data-purge]").nth(2).wait_for(timeout=10000)

    before_count = page.locator("button[data-fork]").count()
    assert before_count == 3, f"expected 3 savepoints before purge, got {before_count}"
    page.screenshot(path="savepoint-purge-before.png", full_page=True)

    # Rows render newest-first (reversed save_points), so the middle row (index 1) anchors
    # the purge on the second-oldest savepoint, leaving the oldest one dropped and this
    # anchor row itself kept.
    page.once("dialog", lambda dialog: dialog.accept())
    anchor_id = page.locator("button[data-purge]").nth(1).get_attribute("data-purge")
    page.locator("button[data-purge]").nth(1).click()
    page.wait_for_function("() => document.querySelectorAll('button[data-fork]').length < 3", timeout=10000)

    after_count = page.locator("button[data-fork]").count()
    assert after_count == 2, f"expected 2 savepoints after purge, got {after_count}"

    # The anchor row (the one that was clicked) must still be present.
    remaining_ids = page.locator("button[data-purge]").evaluate_all("buttons => buttons.map(b => b.dataset.purge)")
    assert anchor_id in remaining_ids, f"anchor {anchor_id} was purged; remaining: {remaining_ids}"
    page.screenshot(path="savepoint-purge-after.png", full_page=True)

    workflow_id = page.url.rstrip("/").split("/")[-1]
    page.evaluate("fetch('/admin/instances?confirm=DELETE_ALL', { method: 'DELETE' })")
    print(f"verified savepoint purge: {workflow_id}, {before_count} -> {after_count} savepoints, anchor {anchor_id} kept")
    browser.close()
