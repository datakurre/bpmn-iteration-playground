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
header = "Authorization"
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
prefix = "Bearer "
secret = "OPENCODE_ZEN_API_KEY"

[[network.allowed_routes]]
header = "Authorization"
host = "opencode.ai:443"
method = "POST"
path = "/go/**"
prefix = "Bearer "
secret = "OPENCODE_GO_API_KEY"
```

# Agent Guidelines & Project Insights

This document captures operational experience and technical details for AI agents working in this repository.

---

## Project Overview

**BPMN Pi Workflow** is a durable BPMN 2.0 orchestration platform. Its direction: a personal
iterative digital design and manufacturing pipeline, where BPMN is the controller replacing
bespoke agentic loops — without reinventing their atoms. Pi remains the agent runtime; BPMN
adds durable state, composable/reusable pipeline fragments (`CallActivity`), human-in-the-loop
checkpoints (FormJS forms), and branchable history (savepoint fork, for design-variant
exploration). The adapter registry decouples orchestration from the agent runtime
(`harness_type` → `BaseAdapter`), so the platform is not LLM-specific — non-LLM tools
(slicers, CAM, simulation) can be wrapped as adapters and orchestrated the same way as Pi.
Track-specific design notes (not committed) live in `plans/` — see `plans/README.md` for
current status per track.

It:

- Parses and executes **BPMN 2.0 diagrams** using [SpiffWorkflow](https://spiffworkflow.org/).
- Persists every workflow instance and savepoint in **ZODB** (optionally distributed via ZEO).
- Delegates `pi_agent` service tasks to a local **Pi CLI** subprocess using non-interactive JSON print mode (`--mode json -p <prompt>`).
- Exposes a **FastAPI** REST + WebSocket API and a browser-based **Workflow Studio** UI (dashboard, instance viewer, history, BPMN editor).
- Supports **FormJS** for human task forms (Camunda extension elements → FormJS JSON schema).
- Implements fork/resume **savepoints** at every durable boundary (`before_harness`, `after_harness`, `human_wait`), preserving `session_id` to continue context trees. Superseded attempts of the same turn are pruned (`SAVEPOINT_ATTEMPT_RETENTION`, default 1).
- Parks the graph on **message and timer catch events**, so external systems and deadlines are nodes in the diagram rather than out-of-band polling.
- Ships focused **Nix flake apps** (`pi-bpmn-json-form-builder`, `pi-text-analysis`, `pi-contract-review`) wrapping Pi with task-specific prompts.
- Runs Pi inside **[agent-sandbox](https://github.com/datakurre/agent-sandbox)** (vendored as a git submodule, `vendor/agent-sandbox`) — a Podman-based sandbox that enforces per-task network/secret policy — via `SandboxPiAdapter`, as an alternative to the bare-subprocess `PiAdapter`.

**Key capabilities:**
- Workflow fork/branch from any saved checkpoint.
- Step-by-step agent turn orchestration with intermediate human gates (e.g. Q&A, plan reviews).
- Failed Pi tasks are persisted with their failure reason; a Retry button re-runs the harness.
- CallActivity (subprocess) support with per-child workflow records synced to the ZODB store — a whole agent-plus-human cycle is reusable as one node (`composed_delivery.bpmn` calls `agent_review_cycle.bpmn`).
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
    base.py          – BaseAdapter ABC (run + prepare_workspace hook) + AgentResult dataclass
    sandbox_policy.py – agent-sandbox network policy rendered into a workspace AGENTS.md
    pi_adapter.py    – PiAdapter: wraps PiClient as a BaseAdapter
    sandbox_adapter.py – SandboxPiAdapter: runs Pi via `agent-sandbox --programmatic` (Podman isolation)
    mock_adapter.py  – MockAdapter: deterministic in-process stub for tests
    registry.py      – AdapterRegistry: maps harness_type → adapter
  templates/         – Jinja2-rendered HTML (dashboard, instance, history, admin, editor)
  static/            – App-level CSS / JS assets
  engine.py          – WorkflowRunner: loads BPMN, starts runs, task snapshots, prompt builder
  workflow_service.py – WorkflowService: orchestration, savepoints, fork, retry, jobs
  persistence.py     – WorkflowStore + WorkflowMetadata backed by ZODB / BlobStorage / ZEO
  pi_client.py       – PiClient: non-interactive CLI runner, extracts sessionId & JSON contract
  events.py          – EventBus: persists audit events + async webhook delivery (httpx, 3 retries)
  auth.py            – Role enum + require_role() FastAPI dependency
  registry.py        – WorkflowRegistry: discovers workflows/*.bpmn templates
  workspace.py       – tar.zst pack/unpack helpers for ZODB Blob workspace storage
  sync_children.py   – thin wrapper over WorkflowService._sync_children
  models.py          – Pydantic models for all API request/response bodies
  logging_config.py  – Structured logging + RequestLoggingMiddleware
  ws.py              – WebSocket connection manager for /ws/instance/{id} push
workflows/           – Executable BPMN 2.0 templates (plan_and_execute, document_generation,
                       bug_triage, contract_review, pr_review, external_gate,
                       composed_delivery + its callable child agent_review_cycle, project)
scripts/
  pi-demo            – Deterministic Pi CLI-compatible mock (no credentials needed)
  verify_*.py        – Playwright-based smoke tests for UI pages
flake.nix            – Nix flake: pi-* variant apps with role-specific prompts
devenv.nix           – devenv: Python 3.14 + Node 22 + uvicorn process + scripts
vendor/agent-sandbox – git submodule: Rust CLI + Podman sandbox, isolates Pi's fs/network/secrets
```

**Data flow for a Pi service task:**
1. `WorkflowService.start()` → `WorkflowRunner.start()` → `BpmnWorkflow.do_engine_steps()`
2. READY Pi tasks discovered → savepoint `before_harness` committed to ZODB
3. `AdapterRegistry.get("pi_agent").run(prompt, config, cwd)` → `PiClient._execute()`
4. Pi executes turn non-interactively via `pi --mode json -p <prompt>` (optionally `--session <id>`)
5. `_parse_json(text)` validates the 5-key JSON result contract
6. On success → the result is written to `task.data`, and **only** the task's declared
   `camunda:outputParameters` are published to `task.workflow.data` → `do_engine_steps()` → savepoint `after_harness`
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
- **Tests**: `devenv shell -- test` runs `pytest --cov=app` (mypy --strict, `tsc --noEmit`, and `vitest` follow).
- **Lint only**: `devenv shell -- lint` runs `mypy app/` (`--strict`) and `tsc --noEmit`.
- **Offline demo**: `devenv shell -- demo` runs uvicorn with `PI_EXECUTABLE=scripts/pi-demo`.

## 2. Local Pi Agent & Deterministic Demo

- **Executable Fallback**: `PI_EXECUTABLE` defaults to `node_modules/.bin/pi` in devenv. Falls back to `scripts/pi-demo` when `PI_OFFLINE=1`, `.pi_offline` file exists, or no `OPENAI_API_KEY` is set.
- **Demo fallback is opt-in**: a *failed* real Pi run only retries against `scripts/pi-demo` when `PI_ALLOW_DEMO_FALLBACK=1`. Off by default — otherwise a misconfigured provider silently feeds fabricated agent output into BPMN gateway conditions.
- **Deterministic Showcase**: `scripts/pi-demo` is a fast RPC-compatible mock that always emits the 5-key JSON result contract without model credentials.
- **Pi Provider Config**: `PI_PROVIDER=opencode-go`, `PI_MODEL=gpt-5.6-luna`, `OPENAI_BASE_URL=https://opencode.ai/zen/v1` set by devenv; passed through `ALLOWED_ENV_VARS` filter in `pi_rpc.py`.
- **Timeout**: Default 1800 s (`PI_TIMEOUT_SECONDS`). Configurable per-deployment. On timeout or cancellation the whole process *group* is killed, since Pi runs with `start_new_session=True`.
- **Workspace**: every instance runs in its own unpacked workspace. `PI_WORKDIR` is a *seed* copied into a fresh workspace (never the agent's cwd), so concurrent instances cannot collide and savepoints capture what the agent actually touched.
- **Resource Limits**: Pi subprocess runs with `RLIMIT_AS=2GB` and optionally drops privileges to `PI_RUN_AS_USER`.
- **Nix flake wrappers**: `nix run .#pi-bpmn-json-form-builder` / `pi-text-analysis` / `pi-contract-review` add role-specific prompts and tool allowlists on top of the base Pi executable.
- **Process-group cleanup**: Pi is spawned in its own session; timeout/cancel/error paths kill the whole process group (`_kill_process_group` in `pi_client.py`), not just the direct child, so tool subprocesses Pi started don't leak.

## 3. Host Browser CDP Automation

- **Host Browser Port**: The host browser runs CDP on port `9222` (`AGENT_SANDBOX_BROWSER_CDP_PORT=9222`).
- **Playwright Execution**: Always execute Playwright scripts via `playwright-python script.py` so Nix Playwright drivers and environment variables are properly wired.
- **Navigation Best Practice**: Use `wait_until="domcontentloaded"` for `page.goto("http://localhost:8000/", ...)` to prevent delays caused by background polling (`setTimeout(refresh, 500)`).
- **Form Fields Selector**: FormJS renders inputs with dynamic IDs ending in field names (e.g. `input[id$='decision']` and `input[id$='notes']`).
- **Verify scripts**: `scripts/verify_*.py` are Playwright smoke tests. Run with `playwright-python scripts/verify_instance_ui.py`.

## 4. SpiffWorkflow & FastAPI Engine Details

- **Publishing agent results (outputParameters only)**: A service task publishes to the
  workflow *exclusively* through `camunda:outputParameters`. Nothing is written to
  `workflow.data` implicitly, so parallel agent turns can no longer overwrite each other's
  verdict. Published values land in `task.data` (the scope gateway conditions evaluate in,
  and inherited per-branch) and in `workflow.data` (the instance-wide view in the API/UI).
  Expression sources available to an `outputParameter`:
  - the agent JSON keys — `status`, `summary`, `findings`, `artifacts`, `next_action`
  - `agent_status` (harness verdict: success/failed/timeout/cancelled), `agent_text`,
    `agent_output`, `agent_exit_code`, `failure_reason`
  `${status}` is the agent's *self-reported* verdict, falling back to the harness verdict
  when no parseable result was produced — that is what a template means by "did the work
  succeed", and it is what the bundled templates route on (`plan_status == 'success'`).
  Note SpiffWorkflow merges the terminal task's data into `workflow.data` when an instance
  completes, so a completed instance's data also carries that last task's local keys.
- **Reading data into a prompt (inputParameters)**: `camunda:inputParameter` expressions are
  resolved by `resolve_input()` (`app/engine.py`), a pure dict/list lookup + string
  substitution helper — deliberately not a general expression language, and it must never
  route through SpiffWorkflow's script engine or `eval` (these values are interpolated into
  agent prompts, so evaluating them would be an injection path from agent output back into
  engine evaluation). Supported syntax:
  - `${name}` — resolves against `workflow.data[name]`.
  - `${a.b.c}` — dotted nested path through dicts; numeric segments (`${findings.0.title}`)
    index into lists. Any miss along the path (missing key, out-of-range or non-numeric
    index, or the path running into a non-container) yields `None`, never a `KeyError`.
  - A **whole-string** expression (the entire value is one `${...}`) returns the resolved
    value with its native type — an int, list, or dict survives, since gateway conditions
    and agent JSON depend on that.
  - A **mixed** string (`"Review ${contract} for ${reviewer}"`) interpolates every `${...}`
    occurrence, stringifying each resolved value; a miss becomes `""` rather than leaking a
    literal `${...}` into the prompt for the agent to puzzle over.
  - A task with no `inputParameters` at all falls back to passing the whole of
    `workflow.data` as `variables` — several bundled templates rely on this.
- **Session lineage**: agent sessions are tracked per execution path in
  `workflow.data["__sessions"]` (task instance id → session id). A turn inherits the
  session of the nearest ancestor on its own branch and forks it (`pi --fork`) when the
  turn is a re-roll (retry, forked instance) or a sibling branch is already running against
  the same session. Because the map lives in workflow data, a savepoint fork inherits the
  lineage with the state.
- **Inbound events**: `POST /instance/{id}/message/{name}` delivers an external message to
  a waiting message catch event (payload merges into task data);
  `GET /instance/{id}/events/pending` lists what an instance is parked on. Timer events
  only advance when `refresh_timers()` is called, which the background ticker does
  every `TIMER_TICK_SECONDS` (default 10, `0` disables). Instances parked on an event
  report status `waiting_event`. A message matching an event-subprocess trigger spawns a
  new child instead of resuming a waiting task (see Event Subprocess Children below); for
  that case only, `send_message` also copies the payload onto the new subprocess's own
  `workflow.data`, not just the triggering task's task data — see the next bullet for why.
- **FormJS Schema Compatibility**: FormJS UMD bundle (`form-viewer.umd.js`) requires schemas formatted with `"type": "default"` and `"components": [...]` (mapping string fields to `"type": "textfield"`). Type mapping lives in `CAMUNDA_TO_FORMJS_TYPE` in `workflow_service.py`.
- **Static Assets Routing**: Specific static mounts (`/static/form-js`) must be mounted in FastAPI before general prefix mounts (`/static`) to ensure correct resolution.
- **Harness Type Dispatch**: Tasks declare their adapter via a `harness_type` Camunda property (default `pi_agent`). `AdapterRegistry` resolves the correct `BaseAdapter`.
- **Savepoints**: Three phases per task — `before_harness`, `after_harness`, `human_wait`. Each deep-copies workflow state + workspace blob into ZODB.
- **Forking**: `POST /instance/{id}/fork/{save_point_id}` duplicates the ZODB record and workspace blob, then resumes from the savepoint.
- **BPMN Extensions**: `engine.py` reads `camunda:properties`, `camunda:formData`, and `camunda:inputOutput`. Input parameters support `${variable}` expression syntax.
- **CallActivity Children**: Child workflows tracked in `data["__children"]`, synced as separate ZODB records with `parent_workflow_id` back-references.
- **Event Subprocess Children**: `_sync_children` also syncs children spawned by a native
  `triggeredByEvent="true"` event subprocess (`workflows/project.bpmn`), the same way as
  CallActivity children, keyed the same way in `data["__children"]`. Two SpiffWorkflow 3.2.0
  quirks this depends on, both verified by running the mechanism rather than assumed:
  - A `triggeredByEvent` subprocess never actually gets classed as `EventSubprocess` at
    parse time (`SubWorkflowParser.create_task()`'s `triggeredByEvent` check reads the
    BPMN-namespaced attribute, but the attribute is always unprefixed on a standard
    `<bpmn:subProcess>` element, so it never matches) — it parses as the plain
    `SubWorkflowTask` class instead. `_sync_children` and `_catching_definitions` both
    check `isinstance(x, SubWorkflowTaskMixin)` (`SpiffWorkflow.bpmn.specs.mixins.
    subworkflow_task`), the shared base, not the specific subclass.
  - `send_message()`'s payload lands on the *triggering task's* task data by default
    (`BpmnEvent.payload`), not on the newly spawned subprocess's own `workflow.data` — but
    `runner.prompt()` (and so every agent turn) reads `${var}` input parameters from
    `workflow.data`. Without `send_message` also copying the payload onto the new
    subprocess directly, a spawned child's own agent turn cannot see what it was spawned to
    do; the payload only surfaces in the child's record after it completes (SpiffWorkflow's
    terminal-task data merge).
- **Project template** (`workflows/project.bpmn`): a long-running Project that never
  completes on its own — main flow parks on a `Project Open` user task (submit it to close
  the Project) while an event subprocess spawns a new child for every
  `POST /instance/{id}/message/spawn_requested` with a `{"task_brief": "..."}` payload. Each
  spawn is a fresh child (SpiffWorkflow reuses a subprocess only if it's still WAITING at its
  own start event, which a spawned child never is once dispatched — don't design around
  reuse). The template shape (park-and-spawn) is convention, not enforced by
  `WorkflowRegistry`; nothing currently validates that a template calling itself a Project
  actually has a trigger spec.

## 4b. Agent Sandbox Integration

- **Submodule**: `vendor/agent-sandbox` (Rust CLI + Podman-based sandbox). Fetch with `make submodules` (`git submodule update --init --recursive`); `make submodule-update` pulls the latest upstream commit.
- **Adapter**: `SandboxPiAdapter` (`app/adapters/sandbox_adapter.py`) shells out to `agent-sandbox --workspace --proxy --secrets --programmatic pi ...`, prefers the vendored release build at `vendor/agent-sandbox/cli/target/release/agent-sandbox`, falls back to `agent-sandbox` on `$PATH`, overridable via `AGENT_SANDBOX_EXECUTABLE`.
- **Registration**: registered under `harness_type` `sandbox_pi` and alias `agent_sandbox`. Set `PI_SANDBOX_ENABLED=1` to make it the adapter for the default `pi_agent` harness type too (sandbox everything without touching BPMN files).
- **Per-task network policy**: `build_agents_md()` (`app/adapters/sandbox_policy.py`) generates/merges a `toml agent-sandbox` block — `allowed_hosts`, `allowed_routes` (proxied secret injection), `ports` — from BPMN task `camunda:properties` (`sandbox_policy` / `network_policy` / `allowed_hosts` / `allowed_routes` / `ports`), layered on the repo's own `AGENTS.md` policy block at the top of this file.
- **Output contract**: the sandbox wraps Pi's stdout in an envelope (`{"status", "stdout", "stderr", "network", "policy_error"}`); the adapter unwraps it, then parses inner lines as Pi JSON events same as the direct adapter.

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
3. For Pi tasks: add `camunda:properties` with at least `agent_role` and optionally `harness_type` (defaults to `pi_agent`). A task whose `harness_type` has no registered adapter now fails loudly rather than stalling.
4. Declare `camunda:inputOutput` — inputs scope what the agent sees, outputs are the only way results reach the workflow. Gateways downstream must route on those output names.
5. `WorkflowRegistry` auto-discovers the file — no code changes needed.

## 8. Adding a New Adapter

1. Subclass `app.adapters.base.BaseAdapter`; implement `adapter_type` property and `run(prompt, config, cwd) -> AgentResult`. Override `prepare_workspace(workdir, config)` if the harness needs configuration on disk before the turn (as `SandboxPiAdapter` does for its network policy).
2. Register via `AdapterRegistry.register(MyAdapter())` in `WorkflowService.__init__` or at app startup.
3. Set `harness_type` in the BPMN task's Camunda properties to your `adapter_type` string.

See §4b for the `SandboxPiAdapter` as a worked example of a second adapter alongside the default `PiAdapter`.
