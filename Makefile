# All dev targets. Under Nix, run them as:
#   nix develop --command make <target>

.PHONY: help setup install submodules submodule-update check-vendor-pins vendor-build \
        build build-cli build-assets build-css dev run studio init \
        lint lint-templates typecheck test test-watch test-coverage verify-editor clean

NPM ?= npm
NODE ?= node
PORT ?= 0

help:
	@echo "Setup"
	@echo "  make setup              - install deps, init submodules, build vendored packages"
	@echo "  make install            - npm install"
	@echo "  make submodules         - initialize and checkout git submodules"
	@echo "  make submodule-update   - update submodules to latest remote HEAD"
	@echo "  make check-vendor-pins  - assert .gitmodules gitlinks match flake.lock revs"
	@echo "  make vendor-build       - build the vendored element-templates submodules"
	@echo ""
	@echo "Build"
	@echo "  make build              - build CLI, editor bundles and CSS"
	@echo "  make build-cli          - bundle src/cli -> dist/graph-agent.js"
	@echo "  make build-assets       - bundle bpmn-js viewer/modeler + pages -> static/"
	@echo "  make build-css          - build Tailwind CSS -> static/tailwind.css"
	@echo ""
	@echo "Run"
	@echo "  make init               - scaffold .agents/ in the current directory"
	@echo "  make run                - run the agent CLI (ARGS=...)"
	@echo "  make studio             - serve the BPMN studio (PORT=0 picks a free port)"
	@echo "  make dev                - rebuild on change and serve the studio"
	@echo ""
	@echo "Check"
	@echo "  make lint               - typecheck + template lint"
	@echo "  make typecheck          - tsc --noEmit"
	@echo "  make lint-templates     - htmlhint over studio pages"
	@echo "  make test               - vitest run"
	@echo "  make test-watch         - vitest watch"
	@echo "  make test-coverage      - vitest run --coverage"
	@echo "  make verify-editor      - drive the editor in a real browser"
	@echo "  make clean              - remove build output and caches"

# ---------------------------------------------------------------- setup

install:
	$(NPM) install

submodules:
	git submodule update --init --recursive

submodule-update:
	git submodule update --init --recursive --remote

# The Nix build takes the vendored sources from flake inputs rather than git
# submodules, because a plain `nix run .` does not fetch submodules. Both paths
# must therefore point at the same commits; this target fails loudly if they drift.
check-vendor-pins:
	$(NODE) scripts/check-vendor-pins.mjs

# vendor/operaton-element-templates depends on vendor/operaton-element-templates-validator
# (via a `file:` dependency), which in turn depends on
# vendor/operaton-element-templates-json-schema (also `file:`), so these must be
# installed/built in dependency order. Each submodule's dist/ is gitignored in its own
# repo (it is build output, not source), so this must be re-run after checkout.
vendor-build: submodules
	cd vendor/operaton-element-templates-json-schema && npm install && npm run build
	cd vendor/operaton-element-templates-validator && npm install
	cd vendor/operaton-element-templates && npm install

setup: install submodules vendor-build

# ---------------------------------------------------------------- build

build-cli:
	$(NPM) run build:cli

build-assets:
	$(NPM) run build:assets

build-css:
	$(NPM) run build:css

build: build-cli build-assets build-css

# ---------------------------------------------------------------- run

init: build-cli
	$(NODE) dist/graph-agent.js init

run: build-cli
	$(NODE) dist/graph-agent.js $(ARGS)

studio: build
	$(NODE) dist/graph-agent.js studio --port $(PORT)

dev:
	$(NODE) scripts/dev.mjs

# ---------------------------------------------------------------- check

typecheck:
	$(NPM) run typecheck

lint-templates:
	$(NPM) run lint:templates

lint: typecheck lint-templates

test:
	$(NPM) test

# Drives a real Chromium against `graph-agent studio`. This is the only place the
# element-templates properties panel is exercised for real; a second bundled copy
# of preact only crashes in a browser.
verify-editor: build
	$(NPM) run verify:editor

test-watch:
	$(NPM) run test:watch

test-coverage:
	$(NPM) run test:coverage

# ---------------------------------------------------------------- clean

clean:
	rm -rf dist static coverage htmlcov
