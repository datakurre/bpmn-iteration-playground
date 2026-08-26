.PHONY: help watch run start demo test lint typecheck install setup clean pack screenshots docs docs-serve submodules submodule submodule-update vendor-build

HOST ?= 127.0.0.1
PORT ?= 8000
UV ?= uv
WATCH_LOG ?= watch.log

help:
	@echo "Available commands:"
	@echo "  make watch            - Run FastAPI server with auto-reload (tees console to \$$(WATCH_LOG))"
	@echo "  make run              - Run FastAPI server"
	@echo "  make demo             - Run server with mock Pi demo agent (no API key required)"
	@echo "  make lint             - Run mypy (--strict) and tsc typecheckers"
	@echo "  make typecheck        - Alias for make lint"
	@echo "  make test             - Run pytest+coverage, mypy, tsc, and vitest"
	@echo "  make pack             - Compact ZODB storage (FileStorage db.pack)"
	@echo "  make screenshots      - Generate docs screenshots using headless browser"
	@echo "  make docs             - Recreate screenshots and build documentation"
	@echo "  make docs-serve       - Serve documentation locally"
	@echo "  make install          - Install Python and Node dependencies"
	@echo "  make submodules       - Initialize and checkout git submodules"
	@echo "  make submodule-update - Update git submodules to latest remote HEAD"
	@echo "  make vendor-build     - Build vendored element-templates submodules (dist/ is gitignored)"
	@echo "  make setup            - Install dependencies, initialize submodules, and build vendored packages"
	@echo "  make clean            - Remove Python and pytest cache files"

watch:
	$(UV) run uvicorn graph_agent.api.server:app --reload --host $(HOST) --port $(PORT) 2>&1 | tee $(WATCH_LOG)

run:
	$(UV) run uvicorn graph_agent.api.server:app --host $(HOST) --port $(PORT)

start: run

demo:
	PI_EXECUTABLE="$(CURDIR)/graph_agent/data/pi-demo" $(UV) run uvicorn graph_agent.api.server:app --reload --host $(HOST) --port $(PORT)

lint:
	$(UV) run ruff check .
	$(UV) run mypy graph_agent/
	npm run typecheck

lint-fix:
	$(UV) run ruff check --fix .

typecheck: lint

test:
	$(UV) run ruff check .
	$(UV) run pytest -q --cov=graph_agent --cov-report=term-missing --cov-report=html
	$(UV) run mypy graph_agent/
	npm run typecheck
	npm test

pack:
	PORT=$(PORT) $(UV) run python scripts/pack_db.py

# The sandbox image ships DejaVu + Liberation only, so the UI's emoji (zoom controls,
# minimap, file icons) render as boxes unless an emoji font is on the fontconfig path.
screenshots:
	FONTCONFIG_FILE=$$(nix build --impure --no-link --print-out-paths --expr \
	  'with (builtins.getFlake "nixpkgs").legacyPackages.$${builtins.currentSystem}; \
	   makeFontsConf { fontDirectories = [ dejavu_fonts liberation_ttf noto-fonts-color-emoji ]; }' \
	  2>/dev/null || echo $$FONTCONFIG_FILE) \
	playwright-python scripts/generate_docs_screenshots.py

docs: screenshots
	@if command -v mkdocs >/dev/null 2>&1; then mkdocs build; else echo "mkdocs not installed locally; run in CI or install mkdocs-material"; fi

docs-serve:
	mkdocs serve

install:
	$(UV) sync
	npm install

submodules:
	git submodule update --init --recursive

submodule: submodules

submodule-update:
	git submodule update --init --recursive --remote

# vendor/operaton-element-templates depends on vendor/operaton-element-templates-validator
# (via a `file:` dependency), which in turn depends on vendor/operaton-element-templates-json-schema
# (also `file:`), so these must be installed/built in dependency order. Each submodule's dist/ is
# gitignored in its own repo (it's build output, not source), so this must be re-run after checkout.
vendor-build: submodules
	cd vendor/operaton-element-templates-json-schema && npm install && npm run build
	cd vendor/operaton-element-templates-validator && npm install
	cd vendor/operaton-element-templates && npm install

setup: install submodules vendor-build

clean:
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	rm -rf .pytest_cache site
