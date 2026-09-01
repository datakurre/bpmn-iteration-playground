# All dev targets. Under Nix, run them as:
#   nix develop --command make <target>

.PHONY: help setup install \
        build build-cli build-assets build-css dev run studio init \
        lint lint-templates lint-bpmn layout typecheck test test-watch test-coverage verify-editor clean

NPM ?= npm
NODE ?= node
HOST ?= 127.0.0.1
PORT ?= 0

help:
	@echo "Setup"
	@echo "  make setup              - install dependencies"
	@echo "  make install            - npm install"
	@echo ""
	@echo "Build"
	@echo "  make build              - build CLI, editor bundles and CSS"
	@echo "  make build-cli          - bundle src/cli -> dist/graph-agent.js"
	@echo "  make build-assets       - bundle bpmn-js viewer/modeler + pages -> static/"
	@echo "  make build-css          - build Tailwind CSS -> static/tailwind.css"
	@echo ""
	@echo "Run"
	@echo "  make init               - seed the user-level config and graph library"
	@echo "  make run                - run the agent CLI (ARGS=...)"
	@echo "  make studio             - serve the BPMN studio (HOST=..., PORT=0 picks a free port)"
	@echo "  make dev                - rebuild on change and serve the studio"
	@echo ""
	@echo "Check"
	@echo "  make lint               - typecheck + template lint"
	@echo "  make typecheck          - tsc --noEmit"
	@echo "  make lint-templates     - htmlhint over studio pages"
	@echo "  make lint-bpmn          - bpmnlint over workflows/"
	@echo "  make layout             - regenerate diagram layout for workflows/"
	@echo "  make test               - vitest run"
	@echo "  make test-watch         - vitest watch"
	@echo "  make test-coverage      - vitest run --coverage"
	@echo "  make verify-editor      - drive the editor in a real browser"
	@echo "  make clean              - remove build output and caches"

# ---------------------------------------------------------------- setup

install:
	$(NPM) install

setup: install

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
	$(NODE) dist/graph-agent.js studio --host $(HOST) --port $(PORT)

dev: build
	HOST=$(HOST) PORT=$(PORT) $(NODE) scripts/dev.mjs

# ---------------------------------------------------------------- check

typecheck:
	$(NPM) run typecheck

lint-templates:
	$(NPM) run lint:templates

# Regenerates DI from the graph -- hand-written <bpmndi:> coordinates go stale
# the moment a node is spliced in.
layout:
	$(NODE) scripts/bpmn-tools.mjs layout workflows/*.bpmn

lint-bpmn:
	$(NODE) scripts/bpmn-tools.mjs lint workflows/*.bpmn

lint: typecheck lint-templates lint-bpmn

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
