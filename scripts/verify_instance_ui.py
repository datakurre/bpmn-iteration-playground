from playwright.sync_api import sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    failures = []
    page.on("requestfailed", lambda request: failures.append(f"{request.url}: {request.failure}"))
    page.goto("http://127.0.0.1:8000/", wait_until="networkidle")
    page.get_by_role("button", name="Start contract review").click()
    page.wait_for_url("**/instance/*")
    page.locator("#canvas svg").first.wait_for(timeout=10000)
    assert page.evaluate("typeof BpmnJS") == "function"
    page.get_by_text("Review Compliance", exact=True).wait_for(timeout=10000)
    page.screenshot(path="instance-bpmn-rendered.png", full_page=True)
    instance_id = page.url.rstrip("/").split("/")[-1]
    page.locator("input[data-field='decision']").fill("approved")
    page.locator("input[data-field='notes']").fill("Diagram route verified.")
    page.get_by_role("button", name="Submit review").click()
    page.get_by_text("completed", exact=True).wait_for(timeout=10000)
    page.goto("http://127.0.0.1:8000/admin", wait_until="networkidle")
    page.get_by_text(instance_id, exact=True).wait_for(timeout=10000)
    page.on("dialog", lambda dialog: dialog.accept())
    page.locator(f"button[data-delete='{instance_id}']").click()
    page.wait_for_timeout(250)
    page.reload(wait_until="networkidle")
    assert instance_id not in page.locator("body").inner_text()
    assert not failures, failures
    print(f"verified instance {instance_id}; local bpmn-js rendered; admin cleanup succeeded")
    browser.close()
