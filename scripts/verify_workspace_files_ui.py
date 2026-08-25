"""Verify the instance view's Workspace Files panel actually renders.

This panel is populated from the instance state payload, not from a second fetch. It shipped
reading `data.workspace_metadata` while the server carried the manifest at the *top level* of
the record, so the guard was always falsy and the card stayed `hidden` forever -- invisible in
the UI even though `GET /instance/{id}/workspace/files` returned a correct manifest the whole
time. A payload-only test cannot catch that; only rendering the page can.

See todos/10-layer-seam-defects.md for the sibling defect found the same way.
"""

from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:8000/", wait_until="domcontentloaded")
    page.select_option("#template-select", "bpmn_agent/data/workflows/contract_review.bpmn")
    page.fill("#contract", "Review this agreement for compliance.")
    page.click("#start")
    page.wait_for_url("**/instance/*")
    workflow_id = page.url.rstrip("/").split("/")[-1]

    # The agent turn has to finish before the workspace holds anything.
    page.locator("button[data-fork]").nth(1).wait_for(timeout=20000)

    card = page.locator("#workspace-files-card")
    card.wait_for(state="visible", timeout=10000)
    assert not card.evaluate("el => el.classList.contains('hidden')"), (
        "workspace files card is still hidden; the panel is bound to a key the state payload "
        "does not carry"
    )

    rows = page.locator("#ws-files a[href*='/workspace/file']")
    row_count = rows.count()
    assert row_count >= 1, f"expected at least one workspace file row, got {row_count}"

    badge = page.locator("#ws-files-badge").inner_text().strip()
    assert badge == str(row_count), f"badge {badge!r} disagrees with {row_count} rendered rows"

    listed = page.locator("#ws-files").inner_text()
    assert "document.md" in listed, f"agent artifact missing from the panel: {listed!r}"

    # The per-file link must actually serve the file, not 404.
    href = rows.first.get_attribute("href")
    status = page.evaluate("async (u) => (await fetch(u)).status", href)
    assert status == 200, f"workspace file link {href} returned {status}"

    page.screenshot(path="workspace-files-verified.png", full_page=True)
    page.evaluate("fetch('/admin/instances?confirm=DELETE_ALL', { method: 'DELETE' })")
    print(f"verified workspace files panel: {workflow_id}, {row_count} file(s) listed, link 200")
    browser.close()
