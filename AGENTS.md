```toml agent-sandbox
[network]
allowed_hosts = [
    "cache.nixos.org:443",
    "channels.nixos.org:443",
    "codeload.github.com:443",
    "devenv.cachix.org:443",
    "files.pythonhosted.org:443",
    "github.com:443,22",
    "opencode.ai:443",
    "registry.npmjs.org:443",
    "releases.nixos.org:443",
]

[ports]
web = 8000

[[network.allowed_routes]]
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
secret = "OPENCODE_ZEN_API_KEY"
header = "Authorization"
prefix = "Bearer "
```

# Agent Guidelines & Project Insights

This document captures operational experience and technical details for AI agents working in this repository.

---

## Project Overview

**BPMN Pi Workflow** is a durable BPMN 2.0 orchestration platform that:

- Parses and executes **BPMN 2.0 diagrams** using [SpiffWorkflow](https://spiffworkflow.org/).
- Persists every workflow instance and savepoint in **ZODB** (optionally distributed via ZEO).
- Delegates `pi_agent` service tasks to a local **Pi CLI** subprocess over a JSONL RPC protocol.
- Exposes a **FastAPI** REST + WebSocket API and a browser-based **Workflow Studio** UI (dashboard, instance viewer, history, BPMN editor).
- Supports **FormJS** for human task forms (Camunda extension elements → FormJS JSON schema).
- Implements fork/resume **savepoints** at every durable boundary (`before_harness`, `after_harness`, `human_wait`).
- Ships focused **Nix flake apps** (`pi-bpmn-json-form-builder`, `pi-text-analysis`, `pi-contract-review`) wrapping Pi with task-specific prompts.

**Key capabilities:**
- Workflow fork/branch from any saved checkpoint.
- Failed Pi tasks are persisted with their failure reason; a Retry button re-runs the harness.
- CallActivity (subprocess) support with per-child workflow records synced to the ZODB store.
- Role-based auth (`ADMIN` / `OPERATOR` / `VIEWER`) via `X-Admin-Token` / `X-Api-Key` headers.
- Webhook event delivery with retry for `workflow_completed`, `pi_failed`, etc.
- Workspace packaging: agent working directories are archived as `tar.zst` blobs in ZODB.
- BPMN template registry auto-discovering `workflows/*.bpmn` with metadata from Camunda `<documentation>`.

---

## Architecture & Module Map

```
app/
  api/
    server.py        – FastAPI app factory; all REST + WS routes
    ui.py            – Server-side HTML page renderers (inline HTML)
  adapters/
    base.py          – BaseAdapter ABC + AgentResult dataclass
    pi_adapter.py    – PiAdapter: wraps PiRpcClient as a BaseAdapter
    mock_adapter.py  – MockAdapter: deterministic in-process stub for tests
    registry.py      – AdapterRegistry: maps harness_type → adapter
  templates/         – Jinja2-rendered HTML (dashboard, instance, history, admin, editor)
  static/            – App-level CSS / JS assets
  engine.py          – WorkflowRunner: loads BPMN, starts runs, task snapshots, prompt builder
  workflow_service.py – WorkflowService: orchestration, savepoints, fork, retry, jobs
  persistence.py     – WorkflowStore + WorkflowMetadata backed by ZODB / BlobStorage / ZEO
  pi_rpc.py          – PiRpcClient: spawns Pi subprocess, streams JSONL events, parses result
  events.py          – EventBus: persists audit events + async webhook delivery (httpx, 3 retries)
  auth.py            – Role enum + require_role() FastAPI dependency
  registry.py        – WorkflowRegistry: discovers workflows/*.bpmn templates
  workspace.py       – tar.zst pack/unpack helpers for ZODB Blob workspace storage
  sync_children.py   – CallActivity child-record sync utility
  models.py          – Pydantic models for all API request/response bodies
  logging_config.py  – Structured logging + RequestLoggingMiddleware
  ws.py              – WebSocket connection manager for /ws/instance/{id} push
workflows/           – Executable BPMN 2.0 templates (9 bundled examples)
scripts/
  pi-demo            – Deterministic Pi RPC-compatible mock (no credentials needed)
  verify_*.py        – Playwright-based smoke tests for UI pages
flake.nix            – Nix flake: pi-* variant apps with role-specific prompts
devenv.nix           – devenv: Python 3.14 + Node 22 + uvicorn process + scripts
```

**Data flow for a Pi service task:**
1. `WorkflowService.start()` → `WorkflowRunner.start()` → `BpmnWorkflow.do_engine_steps()`
2. READY Pi tasks discovered → savepoint `before_harness` committed to ZODB
3. `AdapterRegistry.get("pi_agent").run(prompt, config, cwd)` → `PiRpcClient._execute()`
4. Pi subprocess streams JSONL events; `agent_settled` breaks the read loop
5. `_parse_json(text)` validates the 5-key JSON result contract
6. On success → `task.data.update(output)` + `workflow.data.update(output)` → `do_engine_steps()` → savepoint `after_harness`
7. Failure persisted with `failure_reason`; client retries via `POST /instance/{id}/retry/{task_id}`

**Pi result JSON contract** (required keys):
```json
{ "status": "success", "summary": "...", "findings": [...], "artifacts": [...], "next_action": "..." }
```

---

## 1. Serving the Project (`devenv`)

- **Start Process**: Use `devenv up -d` to launch background processes defined in `devenv.nix`.
- **Wait for Readiness**: Run `devenv processes wait` to block until readiness probes pass (`http://127.0.0.1:8000/health`).
- **Process Status**: Run `devenv processes list` to check process status (`api ready restarts: 0`).
- **Process Cleanup**: Use `devenv processes down` to terminate running process compose instances.
- **Tests**: `devenv shell -- test` runs `pytest -q && mypy app/`.
- **Lint only**: `devenv shell -- lint` runs `mypy app/`.
- **Offline demo**: `devenv shell -- demo` runs uvicorn with `PI_EXECUTABLE=scripts/pi-demo`.

## 2. Local Pi Agent & Deterministic Demo

- **Executable Fallback**: `PI_EXECUTABLE` defaults to `node_modules/.bin/pi` in devenv. Falls back to `scripts/pi-demo` when `PI_OFFLINE=1`, `.pi_offline` file exists, or no `OPENAI_API_KEY` is set.
- **Deterministic Showcase**: `scripts/pi-demo` is a fast RPC-compatible mock that always emits the 5-key JSON result contract without model credentials.
- **Pi Provider Config**: `PI_PROVIDER=opencode-go`, `PI_MODEL=gpt-5.6-luna`, `OPENAI_BASE_URL=https://opencode.ai/zen/v1` set by devenv; passed through `ALLOWED_ENV_VARS` filter in `pi_rpc.py`.
- **Timeout**: Default 1800 s (`PI_TIMEOUT_SECONDS`). Configurable per-deployment.
- **Resource Limits**: Pi subprocess runs with `RLIMIT_AS=2GB` and optionally drops privileges to `PI_RUN_AS_USER`.
- **Nix flake wrappers**: `nix run .#pi-bpmn-json-form-builder` / `pi-text-analysis` / `pi-contract-review` add role-specific prompts and tool allowlists on top of the base Pi executable.

## 3. Host Browser CDP Automation

- **Host Browser Port**: The host browser runs CDP on port `9222` (`AGENT_SANDBOX_BROWSER_CDP_PORT=9222`).
- **Playwright Execution**: Always execute Playwright scripts via `playwright-python script.py` so Nix Playwright drivers and environment variables are properly wired.
- **Navigation Best Practice**: Use `wait_until="domcontentloaded"` for `page.goto("http://localhost:8000/", ...)` to prevent delays caused by background polling (`setTimeout(refresh, 500)`).
- **Form Fields Selector**: FormJS renders inputs with dynamic IDs ending in field names (e.g. `input[id$='decision']` and `input[id$='notes']`).
- **Verify scripts**: `scripts/verify_*.py` are Playwright smoke tests. Run with `playwright-python scripts/verify_instance_ui.py`.

## 4. SpiffWorkflow & FastAPI Engine Details

- **Task State Synchronization & Status Mapping**: The Pi result contract returns `{"status": "success", ...}`. `_complete_pi` maps this to both `task.data["agent_status"]` and `task.data["status"]` (also updating `workflow.data`) so SpiffWorkflow exclusive gateway expressions evaluate variables in task evaluation scope (`agent_status == 'success'`).
- **FormJS Schema Compatibility**: FormJS UMD bundle (`form-viewer.umd.js`) requires schemas formatted with `"type": "default"` and `"components": [...]` (mapping string fields to `"type": "textfield"`). Type mapping lives in `CAMUNDA_TO_FORMJS_TYPE` in `workflow_service.py`.
- **Static Assets Routing**: Specific static mounts (`/static/form-js`) must be mounted in FastAPI before general prefix mounts (`/static`) to ensure correct resolution.
- **Harness Type Dispatch**: Tasks declare their adapter via a `harness_type` Camunda property (default `pi_agent`). `AdapterRegistry` resolves the correct `BaseAdapter`.
- **Savepoints**: Three phases per task — `before_harness`, `after_harness`, `human_wait`. Each deep-copies workflow state + workspace blob into ZODB.
- **Forking**: `POST /instance/{id}/fork/{save_point_id}` duplicates the ZODB record and workspace blob, then resumes from the savepoint.
- **BPMN Extensions**: `engine.py` reads `camunda:properties`, `camunda:formData`, and `camunda:inputOutput`. Input parameters support `${variable}` expression syntax.
- **CallActivity Children**: Child workflows tracked in `data["__children"]`, synced as separate ZODB records with `parent_workflow_id` back-references.

## 5. Auth & Security

- **Roles**: `ADMIN > OPERATOR > VIEWER` via `ADMIN_TOKEN` and `API_KEYS` env vars (`key:role` CSV).
- **No auth configured**: All requests implicitly receive `ADMIN` role (dev mode).
- **Headers**: `X-Admin-Token` → `ADMIN`; `X-Api-Key` → mapped role.
- **Output sanitization**: Agent output strings truncated at 50 000 characters (`_sanitize_output` in `workflow_service.py`).

## 6. Persistence (ZODB)

- **Storage modes**: In-memory (`:memory:`), file (`data/Data.fs` + `data/blobs/`), or ZEO remote (`ZEO_ADDRESS=host:port`).
- **BlobStorage**: Workspace archives stored as ZODB `Blob` objects. `duplicate_blob` copies committed blobs for fork operations.
- **Packing**: `POST /admin/pack` or `/api/history/pack` compacts freed ZODB space. Check stats at `GET /api/history/storage`.
- **Thread safety & Concurrency**: `WorkflowStore` relies on ZODB native multi-version concurrency control (MVCC) and transactions with automatic retry on `ConflictError`. In-place persistent object mutations prevent database bloat.

## 7. Adding New Workflow Templates

1. Create `workflows/<name>.bpmn` with `isExecutable="true"` on the process element.
2. Add `<bpmn:documentation>` inside the process for the registry description.
3. For Pi tasks: add `camunda:properties` with at least `agent_role` and optionally `harness_type` (defaults to `pi_agent`).
4. `WorkflowRegistry` auto-discovers the file — no code changes needed.

## 8. Adding a New Adapter

1. Subclass `app.adapters.base.BaseAdapter`; implement `adapter_type` property and `run(prompt, config, cwd) -> AgentResult`.
2. Register via `AdapterRegistry.register(MyAdapter())` in `WorkflowService.__init__` or at app startup.
3. Set `harness_type` in the BPMN task's Camunda properties to your `adapter_type` string.
