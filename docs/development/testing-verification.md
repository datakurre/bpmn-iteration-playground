# Testing & Screenshot Automation

This guide explains how to run the test suite and automatically regenerate high-resolution documentation screenshots using Playwright in headless mode.

---

## 1. Running Unit Tests

Run the full pytest suite inside the development shell:

```bash
# Using Makefile target
make test

# Or directly with devenv
nix develop -- pytest
```

The test suite covers:
- Complete workflow lifecycle execution (`tests/test_workflow.py`).
- Save point creation, inspection, and timeline forking (`tests/test_workflow.py`).
- Pi client subprocess execution and fallback handling (`tests/test_pi_client.py`).
- ZODB ACID persistence operations (`tests/test_persistence.py`).
- Process history retrieval, filtering, and data cleanup (`tests/test_history.py`).

---

## 2. Headless Screenshot Automation

All documentation screenshots are generated automatically using Playwright in headless Chromium mode inside the sandbox environment.

### Re-generating Screenshots

Make sure the API server is running (`make run` or `make run`), then run:

```bash
make screenshots
```

Or execute the script directly using `playwright-python`:

```bash
playwright-python scripts/generate_docs_screenshots.py
```

### Generated Artifacts

The script executes a complete workflow scenario and captures high-resolution screenshots into `docs/images/`:

1. `docs/images/studio-dashboard.png` — Studio dashboard.
2. `docs/images/instance-review-form.png` — Live instance diagram with FormJS review form.
3. `docs/images/instance-completed.png` — Completed workflow with diagram node markers.
4. `docs/images/savepoint-fork.png` — Forked workflow timeline.
5. `docs/images/process-history.png` — Process history with summary metrics.
6. `docs/images/savepoint-inspector.png` — Save point variable inspector.

---

## 3. GitHub Actions Documentation Deployment

The GitHub Actions workflow located at [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml) builds the documentation site using `mkdocs-material` on every push to `main` and publishes the static documentation site directly to GitHub Pages.
