.PHONY: help watch run start demo test lint typecheck install setup clean pack screenshots docs docs-serve

HOST ?= 0.0.0.0
PORT ?= 8000
UV ?= uv

help:
	@echo "Available commands:"
	@echo "  make watch       - Run FastAPI server with auto-reload"
	@echo "  make run         - Run FastAPI server"
	@echo "  make demo        - Run server with mock Pi demo agent (no API key required)"
	@echo "  make lint        - Run mypy type checker"
	@echo "  make typecheck   - Alias for make lint"
	@echo "  make test        - Run pytest test suite and mypy"
	@echo "  make pack        - Compact ZODB storage (FileStorage db.pack)"
	@echo "  make screenshots - Generate docs screenshots using headless browser"
	@echo "  make docs        - Recreate screenshots and build documentation"
	@echo "  make docs-serve  - Serve documentation locally"
	@echo "  make install     - Install Python and Node dependencies"
	@echo "  make clean       - Remove Python and pytest cache files"

watch:
	$(UV) run uvicorn app.api.server:app --reload --host $(HOST) --port $(PORT)

run:
	$(UV) run uvicorn app.api.server:app --host $(HOST) --port $(PORT)

start: run

demo:
	PI_EXECUTABLE="$(CURDIR)/scripts/pi-demo" $(UV) run uvicorn app.api.server:app --reload --host $(HOST) --port $(PORT)

lint:
	devenv shell -- lint

typecheck: lint

test:
	devenv shell -- test

pack:
	PORT=$(PORT) $(UV) run python scripts/pack_db.py

screenshots:
	playwright-python scripts/generate_docs_screenshots.py

docs: screenshots
	@if command -v mkdocs >/dev/null 2>&1; then mkdocs build; else echo "mkdocs not installed locally; run in CI or install mkdocs-material"; fi

docs-serve:
	mkdocs serve

install:
	$(UV) sync
	npm install

setup: install

clean:
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	rm -rf .pytest_cache site
