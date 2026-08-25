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
- Persists every workflow instance and savepoint in **ZODB**, local to the workspace (`.agents/state/`).
- Delegates `pi_agent` service tasks to a local **Pi CLI** subprocess using non-interactive JSON print mode (`--mode json -p <prompt>`).
- Exposes a **FastAPI** REST + WebSocket API and a browser-based **Workflow Studio** UI (dashboard, instance viewer, history, BPMN editor).
- Supports **FormJS** for human task forms (Camunda extension elements → FormJS JSON schema).
- Implements fork/resume **savepoints** at every durable boundary (`before_harness`, `after_harness`, `human_wait`), preserving `session_id` to continue context trees. Superseded attempts of the same turn are pruned (`SAVEPOINT_ATTEMPT_RETENTION`, default 1).
- Parks the graph on **message and timer catch events**, so external systems and deadlines are nodes in the diagram rather than out-of-band polling.
- Ships focused **Nix flake apps** (`pi-bpmn-json-form-builder`, `pi-text-analysis`, `pi-contract-review`, `pi-beamer-author`) wrapping Pi with task-specific prompts.
- Runs deterministic, non-LLM build steps as first-class BPMN nodes through **`ShellAdapter`** (`harness_type: shell`) — a declared command executed in the instance workspace, whose exit code the graph can branch on (`graph_agent/data/workflows/beamer_slides.bpmn` compiles LaTeX this way).
- Runs Pi inside **[agent-sandbox](https://github.com/datakurre/agent-sandbox)** (vendored as a git submodule, `vendor/agent-sandbox`) — a Podman-based sandbox that enforces per-task network/secret policy — via `SandboxPiAdapter`, as an alternative to the bare-subprocess `PiAdapter`.

**Key capabilities:**
- Workflow fork/branch from any saved checkpoint.
- Step-by-step agent turn orchestration with intermediate human gates (e.g. Q&A, plan reviews).
- Failed Pi tasks are persisted with their failure reason; a Retry button re-runs the harness.
- CallActivity (subprocess) support with per-child workflow records synced to the ZODB store — a whole agent-plus-human cycle is reusable as one node (`composed_delivery.bpmn` calls `agent_review_cycle.bpmn`).
- Role-based auth (`ADMIN` / `OPERATOR` / `VIEWER`) via `X-Admin-Token` / `X-Api-Key` headers.
- Webhook event delivery with retry for `workflow_completed`, `pi_failed`, etc.
- Workspace packaging: agent working directories are archived as `tar.zst` blobs in ZODB.
- BPMN template registry auto-discovering `graph_agent/data/workflows/*.bpmn` with metadata from Camunda `<documentation>`.

---

## Architecture & Module Map

```
graph_agent/
  cli.py             – `graph-agent` / `bpmn` entry point: init/attach/run/ls/show/logs/merge/cancel/serve/status/open/stop
  agents_root.py     – Workspace: `.agents/` root discovery and directory layout
  daemon.py          – `graph-agent serve` free-port bind, runtime.json handshake, is_daemon_alive
  workspace_strategy.py – WorkspaceStrategy: BlobStrategy / WorktreeStrategy / InPlaceStrategy
                        and select_strategy() -- see AGENTS.md §4d
  tui/               – Textual Terminal User Interface
    client.py        – DaemonClient: async HTTP/WebSocket API client
    forms.py         – FormJS schema parser & data extractor
    app.py           – GraphAgentApp main application
    screens/         – RunsScreen, RunDetailScreen, InboxScreen, FormScreen, StartScreen, LogScreen
  api/
    server.py        – FastAPI app factory: lifespan, static mounts, includes routers/ below
    security.py      – OriginHostGuardMiddleware: blocks a page on another origin from
                        driving the daemon (HTTP + WebSocket)
    ui.py            – Server-side HTML page renderers (inline HTML)
    routers/         – One APIRouter per OpenAPI tag; each builds from `get_service`/
                        `get_project_service` closures passed in by server.py
      pages.py        – UI tag: dashboard, history, admin, editor, instance HTML pages
      system.py       – health check + Prometheus /metrics
      websocket.py     – /ws/instance/{id} live push
      templates.py     – harness/template discovery + save-BPMN-XML endpoint
      webhooks.py       – webhook subscription CRUD
      history.py        – /api/history/* storage stats, pack, browse
      instance.py       – /instance/* : state, diagram, workspace, forms, savepoints, fork,
                          messaging, retry, cancel, SSE event stream (largest router)
      workflow.py       – original pre-/instance API surface (start, submit-task, form)
      projects.py       – /project : create/list/detail/spawn/current over ProjectService
  adapters/
    base.py          – BaseAdapter ABC (run + prepare_workspace hook) + AgentResult dataclass
    sandbox_policy.py – shared agent-sandbox setup: executable resolution, workspace
                        AGENTS.md/secretspec.toml seeding, network policy rendering
    pi_adapter.py    – PiAdapter: wraps PiClient as a BaseAdapter
    sandbox_adapter.py – SandboxPiAdapter: runs Pi via `agent-sandbox --json --prompt -` (Podman isolation)
    sandbox_shell_adapter.py – SandboxShellAdapter: ShellAdapter's command via agent-sandbox
    shell_adapter.py – ShellAdapter: runs a BPMN-declared command in the workspace (non-LLM harness)
    mock_adapter.py  – MockAdapter: deterministic in-process stub for tests
    registry.py      – AdapterRegistry: maps harness_type → adapter
  templates/         – Jinja2-rendered HTML (dashboard, instance, history, admin, editor)
  static/            – App-level CSS / JS assets
  engine.py          – WorkflowRunner: loads BPMN, starts runs, task snapshots, prompt builder
  workflow_service.py – WorkflowService: instance lifecycle, messaging, timers; a façade whose
                        savepoint/fork/job-loop/child-sync method bodies live in orchestration/
  orchestration/
    savepoints.py     – recording, reading, and purging durable checkpoints
    fork.py           – branching a new instance from a past savepoint
    jobs.py           – the agent-turn job loop: dispatch / run_pi / complete_pi
    children.py       – mirrors CallActivity / event-subprocess children into the store
  paths.py           – shared workspace-containment check (`contained_path`), used by both
                       the orchestrator and ShellAdapter
  persistence.py     – WorkflowStore + WorkflowMetadata backed by ZODB / BlobStorage
  pi_client.py       – PiClient: non-interactive CLI runner, extracts sessionId & JSON contract;
                       also the shared home for `_final_text`/`_parse_json`/`_kill_process_group`
                       and the other event-parsing helpers PiAdapter and SandboxPiAdapter both use
  events.py          – EventBus: persists audit events + async webhook delivery (httpx, 3 retries)
  auth.py            – Role enum + require_role() FastAPI dependency
  registry.py        – WorkflowRegistry: discovers graph_agent/data/workflows/*.bpmn templates, flags Project ones
  projects.py        – ProjectService: read/write surface for Projects, a projection over
                       instances + metadata (see plans/concepts.md); no state of its own
  workspace.py       – tar.zst pack/unpack helpers for ZODB Blob workspace storage
  sync_children.py   – thin wrapper over WorkflowService._sync_children
  models.py          – Pydantic models for all API request/response bodies
  logging_config.py  – Structured logging + RequestLoggingMiddleware
  ws.py              – WebSocket connection manager for /ws/instance/{id} push
  data/workflows/    – Bundled executable BPMN 2.0 templates, shipped as package data
                       (plan_and_execute, document_generation, bug_triage, contract_review,
                       pr_review, external_gate, composed_delivery + its callable child
                       agent_review_cycle, project)
  data/pi-demo       – Deterministic Pi CLI-compatible mock, also shipped as package data
                       (no credentials needed)
element_templates/   – bpmn-js element templates (JSON) for the editor's template chooser,
                       served by ElementTemplatesRegistry via GET /api/element-templates
scripts/
  verify_*.py        – Playwright-based smoke tests for UI pages
flake.nix            – Nix flake: pi-* variant apps with role-specific prompts
devenv.nix           – devenv: Python 3.14 + Node 22 + uvicorn process + scripts
vendor/agent-sandbox – git submodule: Rust CLI + Podman sandbox, isolates Pi's fs/network/secrets
vendor/operaton-element-templates{,-validator,-json-schema} – git submodules: Operaton/Camunda 7
                       fork of bpmn-js-element-templates + its validator + JSON schema, sibling-linked
                       via `file:` deps; aliased into the modeler bundle in place of the upstream
                       npm package (see `make vendor-build`, scripts/build-assets.mjs)
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

## Development Setups

This project is developed under more than one environment topology. Know which one you're
currently in before assuming how to reach the app or run commands — check for a running
process on `localhost:8000` and for `agent-sandbox`/container markers rather than guessing.

### Setup: sandboxed agent, app on host, host browser

- **You (the agent) run inside a restricted `agent-sandbox` container.** Network access is
  limited to what the `toml agent-sandbox` policy block below allows (§ Agent Sandbox); reaching
  anything else requires the sandbox's proxy and otherwise fails in a policy-shaped way (a bare
  `403 Forbidden`, "Could not resolve host") — see the `agent-sandbox` skill and § 4b.
- **The app runs on the host**, started by the user with `devenv shell -- make watch`
  (auto-reloading uvicorn) — not by you, and not inside your container. Treat it as already
  running; if it isn't reachable, ask the user to start it rather than trying to launch it
  yourself from inside the sandbox.
- **You reach the live app via the host browser**, using the browser skill's host-browser mode
  (CDP against the *host's* browser, not a sandboxed one) at `http://localhost:8000` — see
  § 3 Host Browser CDP Automation for the CDP wiring. `Makefile`'s `HOST ?= 127.0.0.1` binds the
  server to loopback, consistent with it being served for the host and not exposed into the
  container.
- **Every command or subprocess you run yourself** (tests, lint, `pi`, shell/harness
  executions) must go through `vendor/agent-sandbox` using the policy defined in the
  `toml agent-sandbox` block below (§ Agent Sandbox), including `--secrets` so the sandbox's
  proxy injects the credential (`OPENCODE_API_KEY`, shared by both the Zen and Go routes since
  `/zen/**` covers `/zen/go/**` too) instead of exposing it to your process directly — see
  § 4b Agent Sandbox Integration.
- **Follow the running server through `watch.log`, at the repo root.** `make watch` tees its
  full console output (uvicorn's banner and reload notices, plus the app's own structured
  JSON request/event log) to `WATCH_LOG` (default `watch.log`, overridable like `HOST`/`PORT`)
  so the user's terminal and this file always show the same thing — the file is truncated
  fresh on every `make watch` start, so it only ever holds the current session. You can read
  it directly because `/workspace` is bind-mounted into your container, the same path on both
  sides — no CDP or proxy involved, just `tail -n 200 watch.log` or similar. This is distinct
  from `app.log`, the app's own `configure_logging()` output (`graph_agent/logging_config.py`): that
  one only captures the app's own logger records (not uvicorn's reload/startup lines) and
  persists across restarts rather than resetting per session.

## 1. Serving the Project (`devenv`)

- **Start Process**: Use `devenv up -d` to launch background processes defined in `devenv.nix`.
- **Wait for Readiness**: Run `devenv processes wait` to block until readiness probes pass (`http://127.0.0.1:8000/health`).
- **Process Status**: Run `devenv processes list` to check process status (`api ready restarts: 0`).
- **Process Cleanup**: Use `devenv processes down` to terminate running process compose instances.
- **Tests**: `devenv shell -- test` runs `pytest --cov=app` (mypy --strict, `tsc --noEmit`, and `vitest` follow).
- **Lint only**: `devenv shell -- lint` runs `mypy app/` (`--strict`) and `tsc --noEmit`.
- **Offline demo**: `devenv shell -- demo` runs uvicorn with `PI_EXECUTABLE=graph_agent/data/pi-demo`.

## 2. Local Pi Agent & Deterministic Demo

- **Executable Fallback**: `PI_EXECUTABLE` defaults to `node_modules/.bin/pi` in devenv. Falls back to `graph_agent/data/pi-demo` when `PI_OFFLINE=1`, `.pi_offline` file exists, or no `OPENAI_API_KEY` is set.
- **Demo fallback is opt-in**: a *failed* real Pi run only retries against `graph_agent/data/pi-demo` when `PI_ALLOW_DEMO_FALLBACK=1`. Off by default — otherwise a misconfigured provider silently feeds fabricated agent output into BPMN gateway conditions.
- **Deterministic Showcase**: `graph_agent/data/pi-demo` is a fast RPC-compatible mock that always emits the 5-key JSON result contract without model credentials.
- **Pi Provider Config**: `PI_PROVIDER=opencode-go`, `PI_MODEL=gpt-5.6-luna`, `OPENAI_BASE_URL=https://opencode.ai/zen/v1` set by devenv; passed through the `ALLOWED_ENV_VARS` filter in `pi_client.py`.
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
- **Task scope vs. process scope (Camunda's task-scope-variables model)**: the raw,
  per-turn execution telemetry — prompt/payload, full output, stdout/stderr, the harness's
  own `failure_reason` — lives on `record["jobs"][task_id]` (`job` in
  `graph_agent/orchestration/jobs.py`, surfaced as the `jobs` field in the API/UI), *never* on
  SpiffWorkflow's own `task.data`. The two look interchangeable but are not: `task.data` is
  inherited by successor tasks along a branch, and SpiffWorkflow's own engine merges the
  *terminal* task's `task.data` into `workflow.data` when the instance completes — so a
  scratch key written there for "task-local inspection" doesn't stay task-local. It survives
  every retry (a later success only *adds* keys; nothing ever popped the previous failure's),
  and resurfaces in the *completed* instance's `workflow.data` — which is why a task that
  failed once and then succeeded on retry could still show `failure_reason` in the final
  workflow data. `job`, by contrast, is never read by SpiffWorkflow, so nothing written there
  can leak into process-level data regardless of how the graph completes. Only explicitly
  `published` `camunda:outputParameters` values are written to `task.data`/`workflow.data` —
  that boundary is the actual task-scope/process-scope split, and `job` is where anything
  *not* meant to cross it belongs.
  Note SpiffWorkflow merges the terminal task's data into `workflow.data` when an instance
  completes, so a completed instance's data also carries that last task's local keys.
- **Reading data into a prompt (inputParameters)**: `camunda:inputParameter` expressions are
  resolved by `resolve_input()` (`graph_agent/engine.py`), a pure dict/list lookup + string
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
  - A task with no `inputParameters` at all gets an **empty** scope, not the whole of
    `workflow.data` — see `docs/variable-scoping-plan.md`. Explicit scoping now also covers
    `CallActivity` (`camunda:inputOutput` on the call activity element itself, resolved via the
    same `resolve_scope_inputs()`/`resolve_output_mapping()` helpers, patched onto
    `CallActivity.copy_data`/`update_data` in `engine.py`) and `UserTask` submission (filtered
    through declared `outputParameter`s, or the task's own `camunda:formData` field ids when
    none are declared). `composed_delivery.bpmn`'s `CallActivity_Review` is the worked example.
- **Session lineage**: agent sessions are tracked per execution path in
  `workflow.data["__sessions"]` (task instance id → session id). A turn inherits the
  session of the nearest ancestor on its own branch and forks it (`pi --fork`) when the
  turn is a re-roll (retry, forked instance) or a sibling branch is already running against
  the same session. Because the map lives in workflow data, a savepoint fork inherits the
  lineage with the state.
- **Inbound events**: `POST /instance/{id}/message/{name}` delivers an external message to
  a waiting message catch event; `GET /instance/{id}/events/pending` lists what an instance is
  parked on. Timer events only advance when `refresh_timers()` is called, which the background
  ticker does every `TIMER_TICK_SECONDS` (default 10, `0` disables). Instances parked on an
  event report status `waiting_event`. The payload merges into the catching task's *own
  containing (sub)workflow's* `data` — not just its task data — so a downstream task's
  `camunda:inputParameter` (which reads `workflow.data`, not the task.data inheritance chain)
  actually sees it. A message matching an event-subprocess trigger spawns a new child instead
  of resuming a waiting task (see Event Subprocess Children below); for that case, the payload
  goes onto the new subprocess's own `workflow.data` the same way, since there's no existing
  catching task to attribute it to.
- **FormJS Schema Compatibility**: FormJS UMD bundle (`form-viewer.umd.js`) requires schemas formatted with `"type": "default"` and `"components": [...]` (mapping string fields to `"type": "textfield"`). Type mapping lives in `CAMUNDA_TO_FORMJS_TYPE` in `workflow_service.py`.
- **Static Assets Routing**: Specific static mounts (`/static/form-js`) must be mounted in FastAPI before general prefix mounts (`/static`) to ensure correct resolution.
- **Harness Type Dispatch**: Tasks declare their adapter via a `harness_type` Camunda property (default `DEFAULT_HARNESS_TYPE`, `pi_agent`). `AdapterRegistry` resolves the correct `BaseAdapter`. A declared harness with no registered adapter fails loudly — there is no fallback to Pi.
- **Adapter Capabilities**: `AdapterCapabilities` (`graph_agent/adapters/base.py`) is how a harness declares its own nature — `supports_sessions`, `consumes_prompt`, `timeout_env_var`, `no_output_hint`, `view` — so orchestration asks instead of testing `harness_type == "pi_agent"`. Session threading is skipped entirely for harnesses that declare no session support; a deterministic step holding an inherited id used to register as a colliding sibling and force real agent turns to fork. `GET /api/harnesses` exposes the registered declarations.
- **Savepoints**: Three phases per task — `before_harness`, `after_harness`, `human_wait`. Each deep-copies workflow state + workspace blob into ZODB.
- **Forking**: `POST /instance/{id}/fork/{save_point_id}` duplicates the ZODB record and workspace blob, then resumes from the savepoint.
- **BPMN Extensions**: `engine.py` reads `camunda:properties`, `camunda:formData`, and `camunda:inputOutput`. Input parameters support `${variable}` expression syntax. Every `*.bpmn` in the directory is parsed into one `BpmnParser` (that is how CallActivity targets resolve) and then walked for extensions, but `_specs_defined_by()` scopes each file's extensions to the processes that file itself declares — otherwise two templates sharing a task id would cross-apply properties, forms and inputOutput in filesystem glob order. `_specs_defined_by()` matches `<bpmn:process>`, `<bpmn:subProcess>`, `<bpmn:transaction>`, and `<bpmn:adHocSubProcess>` elements against `workflow.spec`/`workflow.subprocess_specs` — a task nested inside an embedded or event subprocess gets its own spec entry there (keyed by the subprocess element's own id, e.g. `"Spawn"`), separate from the top-level process spec, and previously got none of its extensions attached at all.
- **CallActivity Children**: Child workflows tracked in `data["__children"]`, synced as separate ZODB records with `parent_workflow_id` back-references.
- **Event Subprocess Children**: `_sync_children` also syncs children spawned by a native
  `triggeredByEvent="true"` event subprocess (`graph_agent/data/workflows/project.bpmn`), the same way as
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
- **Project template** (`graph_agent/data/workflows/project.bpmn`): a long-running Project that never
  completes on its own — main flow parks on a `Project Open` user task (submit it to close
  the Project) while an event subprocess spawns a new child for every
  `POST /instance/{id}/message/spawn_requested` with a `{"task_brief": "..."}` payload. Each
  spawn is a fresh child (SpiffWorkflow reuses a subprocess only if it's still WAITING at its
  own start event, which a spawned child never is once dispatched — don't design around
  reuse). The template shape (park-and-spawn) is convention, not enforced by
  `WorkflowRegistry`; nothing currently validates that a template calling itself a Project
  actually has a trigger spec.
- **Projects API**: `ProjectService` (`graph_agent/projects.py`) is a read/write projection over
  Project-declaring root instances — no record of its own, see plans/concepts.md "Project
  identity is convention, not a record". `POST /project` (name + optional bpmn_path) opens
  one, `GET /project` lists them, `GET /project/{slug}` returns detail + children +
  Project-scoped side-store state, `POST /project/{slug}/spawn` is a thin wrapper over
  `send_message(..., "spawn_requested", ...)`. The dashboard still lists raw instances, not
  Projects — the UI half of plans/concepts.md's Backlog item 2/3 is still open.

## 4b. Agent Sandbox Integration

- **Submodule**: `vendor/agent-sandbox` (Rust CLI + Podman-based sandbox). Fetch with `make submodules` (`git submodule update --init --recursive`); `make submodule-update` pulls the latest upstream commit.
- **`pi` is baked into the sandbox image**: `vendor/agent-sandbox/pi-coding-agent.nix` packages the published `@earendil-works/pi-coding-agent` npm tarball as a real `buildNpmPackage` derivation, alongside every other agent in `agents.nix`. It used to resolve via `npx -y @earendil-works/pi-coding-agent` at every container launch — needing live registry.npmjs.org access for a basic feature and breaking outright on any registry hiccup (a transient `403`, not hypothetical). The npm fetch now happens once, at image-build time; no container launch needs npm/network access to start `pi`.
- **Executable resolution**: `resolve_sandbox_command_prefix()` (`graph_agent/adapters/sandbox_policy.py`), shared by both sandbox adapters below. Priority: explicit override (constructor arg or `AGENT_SANDBOX_EXECUTABLE`) > the vendored release build at `vendor/agent-sandbox/cli/target/release/agent-sandbox` > `nix run vendor/agent-sandbox --`, which always builds from the checked-out submodule > a bare `agent-sandbox` resolved from `$PATH`. The `$PATH` fallback exists but ranks last on purpose: a host-wide install can predate the vendored submodule's flags entirely and fail in a way that reads like a typo (`'--programmatic' is not an agent-sandbox flag`) rather than a version mismatch — `nix run` is what actually guarantees the two stay in sync, at the cost of a slower first invocation (evaluates/builds the flake) unless already cached.
- **Programmatic mode flags**: `--prompt -` (feed the named agent its prompt from stdin) and `--json` (machine-readable stdout) are independent — `--json --prompt -` together are what the old single `--programmatic` flag used to mean. `--json` alone, with no agent and a `-- COMMAND`, streams one `{"type": "output", "stream", "line"}` object per output line as the command runs (so a long build still tails live) followed by a closing `{"type": "exit", "status", "stdout", "stderr", "network", "policy_error"}` summary; `--json --prompt -` instead buffers the whole run and reports one such closing object once the agent exits. See `vendor/agent-sandbox/docs/usage.md`'s Programmatic mode section for the full flag table.
- **Pi adapter**: `SandboxPiAdapter` (`graph_agent/adapters/sandbox_adapter.py`) shells out to `agent-sandbox --workspace --proxy --secrets --json --prompt - pi ...`. Registered under `harness_type` `sandbox_pi` and alias `agent_sandbox`. Set `PI_SANDBOX_ENABLED=1` to make it the adapter for the default `pi_agent` harness type too (sandbox everything without touching BPMN files).
- **Shell adapter**: `SandboxShellAdapter` (`graph_agent/adapters/sandbox_shell_adapter.py`) subclasses `ShellAdapter`, wrapping its resolved argv as `agent-sandbox --workspace --proxy --secrets -- <argv>` — same BPMN properties (`command`/`shell`/`workdir`/`timeout`/`artifacts`/...), just sandboxed. Registered as `harness_type` `sandbox_shell`. Runs as plain passthrough today (no `--json`): the CLI's streamed-JSON mode for a bare command exists and is tested (`cli/tests/launcher_argv.rs`), but `SandboxShellAdapter` doesn't parse it yet, so `network`/`policy_error` aren't surfaced for sandboxed shell tasks the way they are for sandboxed Pi turns — wiring that up means teaching `run()` to unwrap NDJSON `type: output`/`type: exit` lines instead of inheriting `ShellAdapter.run()`'s raw-line pump unchanged.
- **Per-task network policy and secrets**: `prepare_sandbox_workspace()` (`graph_agent/adapters/sandbox_policy.py`), the `prepare_workspace` hook for both sandbox adapters. Renders/merges a `toml agent-sandbox` AGENTS.md block — `allowed_hosts`, `allowed_routes` (proxied secret injection), `ports` — from BPMN task `camunda:properties` (`sandbox_policy` / `network_policy` / `allowed_hosts` / `allowed_routes` / `ports`), and copies a `secretspec.toml` into the workspace so `--secrets` can resolve it (agent-sandbox resolves `secretspec.toml` from its own cwd, which for a sandboxed adapter is the per-instance workspace `--workspace` mounts — not this repo's checkout — so without this every `--secrets` run fails secretspec resolution outright). Both are seeded from `graph_agent/data/workspace_templates/<sandbox_template>/`, deliberately not this repo's own root AGENTS.md/secretspec.toml (those describe the coding agent's own dev sandbox, not a BPMN task's). Each sandboxed adapter has its own default template, matching its own actual need: `SandboxPiAdapter` defaults to `agent_sandbox` (`graph_agent/data/workspace_templates/agent_sandbox/`), scoped to what a default Pi turn needs (`opencode.ai` + the OpenCode-go secret route); `SandboxShellAdapter` defaults to `sandbox_shell` (`graph_agent/data/workspace_templates/sandbox_shell/`), which declares package-registry hosts but **no routes at all**. A task opts into a different base with a `sandbox_template` property naming another `graph_agent/data/workspace_templates/<name>/` directory.
- **`--secrets` is conditional for shell, and toggleable for Pi**: `--secrets` resolves *every* declared route eagerly and refuses to launch at all if any can't be satisfied (`cli/src/secrets.rs`'s `missing required secret`) — so a route nobody configured a key for breaks the whole launch, not just the part of the run that would have used it. `SandboxShellAdapter` only adds `--secrets` when `workspace_policy_declares_routes()` finds the rendered workspace policy actually declares one; a deterministic build step with the default `sandbox_shell` template (no routes) never passes it. `SandboxPiAdapter` passes `--secrets` (plus the `-e OPENCODE_API_KEY=...` placeholder Pi's local pre-flight check needs) whenever `PI_SANDBOX_SECRETS_ENABLED` is unset or `1`, its default — a Pi turn calling out to a model provider through the placeholder-keyed route needs it resolved to do anything useful. Set `PI_SANDBOX_SECRETS_ENABLED=0` when Pi already holds a real credential from its own `/login` (persisted in the mounted `.pi` state, resolved ahead of any env var and outside the proxy entirely) — there `--secrets` has nothing to inject and would only demand a route the host hasn't necessarily configured a key for.
- **Output contract** (Pi): the sandbox wraps Pi's stdout in the `type: "exit"` envelope above; the adapter unwraps it, then parses inner lines as Pi JSON events same as the direct adapter.

## 4c. Shell Harness (deterministic pipeline steps)

- **Adapter**: `ShellAdapter` (`graph_agent/adapters/shell_adapter.py`), registered as `harness_type` `shell`. This is the non-LLM half the adapter registry exists for — a compiler, slicer, or CAM step is a BPMN node like any other.
- **Trust boundary**: the adapter *ignores the generated prompt entirely*. `command` comes only from the task's `camunda:properties`, never from workflow data, for the same reason `resolve_input()` refuses to evaluate workflow data as code: that data is largely agent-written.
- **Properties**: `command` (required unless `template` is set), `shell` (run via `/bin/sh -c`), `workdir`, `template`, `timeout`, `artifacts` (globs), `fail_on_error`, `env` (JSON), `log_tail`.
- **Failure is data, not a halt**: by default a non-zero exit fails the turn, which parks the instance for a human Retry. Setting `fail_on_error="false"` inverts that — the *turn* succeeds while the published `${status}` is `failed`, so an exclusive gateway can route the failure instead of stalling. This is what makes a compiler-in-the-loop possible. In `beamer_slides.bpmn` that route is a human diagnosis gate rather than a direct loop back to the agent, which is what bounds the repair cycle without needing a counter the expression language deliberately cannot provide.
- **Output contract**: mirrors the agent JSON contract (`status`, `summary`, `findings`, `artifacts`, `next_action`) plus `exit_code`, `stdout`, `stderr`, `log`, so the same `camunda:outputParameter` idiom works for agent and non-agent tasks alike.
- **Workspace templates**: `template="<name>"` copies `graph_agent/data/workspace_templates/<name>/` into the instance workspace via the `prepare_workspace` hook, **never overwriting existing files** — so agent edits survive later turns re-running the scaffold. A task declaring only `template` (no `command`) is a pure scaffold step.
- **Streaming**: each output line is emitted as a `shell_output` event through the same `on_event` channel Pi turns use, so a long build tails live in the instance UI. Output is chunk-read, not `readline()`-read, because a LaTeX log line can exceed `StreamReader`'s 64 KiB limit.

## 4d. Workspace Execution Strategies

Phase 3 of the meta-agent refactor (`docs/meta-agent-refactor-plan.md`) — where an agent
turn's files actually live is a `WorkspaceStrategy`
(`graph_agent/workspace_strategy.py`), not one hardcoded behaviour:

- **`BlobStrategy`** — the original behaviour and the only strategy when a
  `WorkflowService` has no `Workspace` attached (every test in this suite, and any
  library usage that hasn't opted in): an ephemeral scratch dir unpacked from a ZODB blob
  per turn, packed back with an optimistic-concurrency version check
  (`WorkspaceConflictError`) on release. The only correct choice for a template that
  wants an empty directory to scaffold into (`beamer_slides.bpmn` declares
  `workspace_mode=blob` on every task for exactly this reason — its `template="beamer"`
  step would be nonsensical against a full project checkout).
- **`WorktreeStrategy`** — automatic once a real `Workspace` is attached (a genuine
  `bpmn serve`) and it's a git checkout: a real `git worktree` per run
  (`.agents/worktrees/<workflow_id>`, branch `bpmn/run/<workflow_id>`), off HEAD. A
  savepoint is a commit on that branch (`workspace_ref`, a SHA); fork is a new worktree
  at that commit on its own new branch (`WorktreeStrategy.restore`) — an isolated,
  mergeable checkout, not a blob copy. This is the default for the same reason it is also
  the safer one: `.agents/` is never git-tracked, so it is structurally absent from every
  worktree checkout regardless of what an agent turn does inside it.
- **`InPlaceStrategy`** — automatic when the workspace isn't a git repo (or an explicit
  opt-in). The launch directory itself, serialised by a per-workspace-root
  `asyncio.Lock` so concurrent turns don't collide — several graphs can still park,
  think, and wait on humans concurrently, but only one harness holds the tree at a time.
  `supports_snapshot = False`: savepoints still capture graph state (retry, resume,
  history), just no file-level checkpoint, and a fork attempt is rejected with a typed
  409 (`{"error": "workspace_snapshot_unsupported", "mode": "in_place"}`) rather than
  silently handing the new instance an empty workspace.

**Security posture, stated plainly**: under `InPlaceStrategy`, an agent turn's `cwd` *is*
`workspace.root` — which contains `.agents/` as a real, ordinary subdirectory (ZODB
state, the running daemon's bearer token in `runtime.json`, other runs' worktrees). A
non-sandboxed adapter (`PiAdapter`, `ShellAdapter`) has full read/write filesystem access
from that `cwd`, the same as any traditional coding agent — there is no code-level
boundary keeping a turn out of `.agents/` in this mode, only the agent's own restraint. A
sandboxed adapter's `--workspace` mount is similarly scoped to whatever `cwd` it's handed,
so it inherits the same exposure under in-place mode (`agent-sandbox` mounts the directory
it's launched in wholesale; it has no sub-path exclusion flag to carve `.agents/` back
out). This is exactly why worktree is the default wherever git makes it possible — a
worktree's checkout structurally never contains `.agents/` at all, sandboxed or not — and
why `bpmn init` prints an explicit warning (see `graph_agent/cli.py`'s `_cmd_init`) the
moment it detects a non-git workspace, rather than letting a user discover this by
reading code.

## 5. Auth & Security

- **Roles**: `ADMIN > OPERATOR > VIEWER` via `ADMIN_TOKEN` and `API_KEYS` env vars (`key:role` CSV).
- **No auth configured**: All requests implicitly receive `ADMIN` role (dev mode).
- **Headers**: `X-Admin-Token` → `ADMIN`; `X-Api-Key` → mapped role.
- **Output sanitization**: Agent output strings truncated at 50 000 characters (`_sanitize_output` in `graph_agent/orchestration/jobs.py`).

## 6. Persistence (ZODB)

- **Storage modes**: In-memory (`:memory:`) or file, local to the workspace (`.agents/state/Data.fs` + `.agents/state/blobs/`). No remote/shared mode -- state is local to the workspace it runs against, not a service other processes share.
- **BlobStorage**: Workspace archives stored as ZODB `Blob` objects. `duplicate_blob` copies committed blobs for fork operations.
- **Packing**: `POST /admin/pack` or `/api/history/pack` compacts freed ZODB space. Check stats at `GET /api/history/storage`.
- **Thread safety & Concurrency**: `WorkflowStore` relies on ZODB native multi-version concurrency control (MVCC) and transactions with automatic retry on `ConflictError`. In-place persistent object mutations prevent database bloat.

## 7. Adding New Workflow Templates

1. Create `graph_agent/data/workflows/<name>.bpmn` with `isExecutable="true"` on the process element.
2. Add `<bpmn:documentation>` inside the process for the registry description.
3. For Pi tasks: add `camunda:properties` with at least `agent_role` and optionally `harness_type` (defaults to `pi_agent`). A task whose `harness_type` has no registered adapter now fails loudly rather than stalling.
4. Declare `camunda:inputOutput` — inputs scope what the agent sees, outputs are the only way results reach the workflow. Gateways downstream must route on those output names.
5. `WorkflowRegistry` auto-discovers the file — no code changes needed.

## 8. Adding a New Adapter

1. Subclass `graph_agent.adapters.base.BaseAdapter`; implement `adapter_type` property and `run(prompt, config, cwd) -> AgentResult`. Override `prepare_workspace(workdir, config)` if the harness needs configuration on disk before the turn (as `SandboxPiAdapter` does for its network policy).
2. Register via `AdapterRegistry.register(MyAdapter())` in `WorkflowService.__init__` or at app startup.
3. Set `harness_type` in the BPMN task's Camunda properties to your `adapter_type` string.

See §4b for the `SandboxPiAdapter` as a worked example of a second agent adapter, and §4c for `ShellAdapter` as a worked example of a *non-agent* harness — the case where `prompt` is ignored and the task is defined entirely by its BPMN properties.

## Agent Sandbox

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
    "pypi.org:443",
    "registry.npmjs.org:443",
    "releases.nixos.org:443",
]

[[network.allowed_routes]]
header = "Authorization"
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
prefix = "Bearer "
secret = "OPENCODE_API_KEY"
```

