"""Verify the savepoint purge affordance against the real UI.

The anchor is a **task**, not the clicked savepoint, because `before_task_id` is all the
request can express. An agent task records two savepoints (`before_harness`,
`after_harness`), so anchoring on it has to keep *both* -- otherwise clicking Purge on the
earlier one deletes the very row you clicked, which is what the confirmation dialog promised
to keep. See todos/10-layer-seam-defects.md.
"""

from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:8000/", wait_until="domcontentloaded")
    # /api/templates repopulates #template-select asynchronously and can reorder it, so pin
    # the workflow explicitly instead of relying on the option order at click time.
    page.select_option("#template-select", "graph_agent/data/workflows/contract_review.bpmn")
    page.fill("#contract", "Review this agreement for compliance.")
    page.click("#start")
    page.wait_for_url("**/instance/*")
    page.locator("button[data-purge]").nth(2).wait_for(timeout=10000)

    before_count = page.locator("button[data-fork]").count()
    assert before_count == 3, f"expected 3 savepoints before purge, got {before_count}"
    page.screenshot(path="savepoint-purge-before.png", full_page=True)

    # Rows render newest-first. Rows 1 and 2 are the agent task's after_harness and
    # before_harness; row 0 is the human_wait savepoint, which belongs to the UserTask.
    # Anchoring on row 1 or 2 must therefore purge NOTHING -- both belong to the anchor task,
    # and nothing older than that task exists.
    anchor_ids = page.locator("button[data-purge]").evaluate_all(
        "buttons => buttons.map(b => b.dataset.purge)"
    )
    dialogs: list[str] = []
    page.once("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
    page.locator("button[data-purge]").nth(2).click()
    page.wait_for_timeout(500)
    assert dialogs and "nothing to purge" in dialogs[0].lower(), (
        f"anchoring on the agent task's oldest savepoint should purge nothing; got {dialogs}"
    )
    assert page.locator("button[data-fork]").count() == 3, "a no-op purge must not delete anything"

    # Anchoring on the human_wait savepoint drops both of the agent task's savepoints.
    page.once("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
    page.locator("button[data-purge]").nth(0).click()
    page.wait_for_function("() => document.querySelectorAll('button[data-fork]').length < 3", timeout=10000)

    after_count = page.locator("button[data-fork]").count()
    assert after_count == 1, f"expected 1 savepoint after purge, got {after_count}"
    assert "2 savepoints" in dialogs[1], f"dialog must name the count it will delete: {dialogs[1]!r}"

    # The anchor row (the one that was clicked) must still be present.
    remaining_ids = page.locator("button[data-purge]").evaluate_all("buttons => buttons.map(b => b.dataset.purge)")
    assert anchor_ids[0] in remaining_ids, f"anchor {anchor_ids[0]} was purged; remaining: {remaining_ids}"
    page.screenshot(path="savepoint-purge-after.png", full_page=True)

    workflow_id = page.url.rstrip("/").split("/")[-1]
    page.evaluate("fetch('/admin/instances?confirm=DELETE_ALL', { method: 'DELETE' })")
    print(
        f"verified savepoint purge: {workflow_id}, {before_count} -> {after_count} savepoints, "
        f"anchor {anchor_ids[0]} kept, no-op purge refused"
    )
    browser.close()
