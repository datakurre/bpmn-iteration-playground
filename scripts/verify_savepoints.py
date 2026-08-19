from playwright.sync_api import sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:8000/", wait_until="networkidle")
    page.get_by_role("button", name="Start contract review").click()
    page.wait_for_url("**/instance/*")
    page.locator("button[data-fork]").nth(2).wait_for(timeout=10000)
    source_id = page.url.rstrip("/").split("/")[-1]
    assert page.locator(".savepoint").count() == 3
    page.screenshot(path="savepoints-before-fork.png", full_page=True)

    source_url = page.url
    page.locator("button[data-fork]").nth(0).click()
    page.wait_for_function("source => location.href !== source", arg=source_url)
    before_fork_id = page.url.rstrip("/").split("/")[-1]
    assert before_fork_id != source_id
    page.locator("#tasks").get_by_text("Review Compliance", exact=True).wait_for(timeout=10000)

    page.goto(f"http://127.0.0.1:8000/instance/{source_id}", wait_until="networkidle")
    source_url = page.url
    page.locator("button[data-fork]").nth(1).click()
    page.wait_for_function("source => location.href !== source", arg=source_url)
    after_fork_id = page.url.rstrip("/").split("/")[-1]
    assert after_fork_id not in {source_id, before_fork_id}
    page.locator("#tasks").get_by_text("Review Compliance", exact=True).wait_for(timeout=10000)
    state = page.evaluate("fetch(location.pathname + '/state').then(response => response.json())")
    assert state["status"] == "waiting_human"
    page.screenshot(path="savepoints-after-fork.png", full_page=True)
    page.evaluate("fetch('/admin/instances?confirm=DELETE_ALL', { method: 'DELETE' })")
    print(f"verified save points and forks: {source_id}, {before_fork_id}, {after_fork_id}")
    browser.close()
