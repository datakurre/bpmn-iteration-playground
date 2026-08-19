# BPMN Pi Workflow

FastAPI persists SpiffWorkflow instances in ZODB and delegates AI service tasks
to a local Pi process through Pi's JSONL RPC protocol.

## Run

```bash
devenv up -d
devenv processes wait
```

Open `http://127.0.0.1:8000/` for the Workflow Studio dashboard. Start a
workflow with `POST /workflow/start`, or use the dashboard. Pi tasks run in a
local RPC subprocess and return a validated JSON result. Human tasks remain
waiting until `POST /workflow/{workflow_id}/submit-task/{task_id}` is called.
Failed Pi tasks remain persisted with their failure reason until the user
presses `Retry` in the instance UI or calls the retry endpoint.

Each persisted instance has stateful routes under `/instance/{instanceId}`:
`/state`, `/diagram`, `/form/{taskId}`, and `/submit-task/{taskId}`. The
`/instance/{instanceId}` page renders the persisted BPMN XML with local
`bpmn-js` assets and highlights active tasks. `/admin` lists and deletes stored
instances; set `ADMIN_TOKEN` to require an `X-Admin-Token` header.

Every wait boundary creates a durable save point: `before_harness`,
`after_harness`, and `human_wait` where applicable. The instance page exposes a
`Fork` action for each save point. Forking before the harness reruns Pi;
forking after the harness resumes orchestration without rerunning Pi.

For a deterministic local showcase without model credentials:

```bash
devenv processes down
devenv shell -- demo
```

The demo command uses `scripts/pi-demo` as a Pi RPC-compatible process. The
normal devenv installs the pinned Pi CLI at `node_modules/.bin/pi` and points
`PI_EXECUTABLE` there automatically.

## Pi Variants

The flake packages focused wrappers around the local Pi CLI:

```bash
nix run .#pi-bpmn-json-form-builder -- "Build a Camunda form"
nix run .#pi-text-analysis -- "Analyze this text"
nix run .#pi-contract-review -- "Review this contract"
```

Each wrapper supplies a task-specific system prompt and tool allowlist. The
underlying executable is selected with `PI_EXECUTABLE` and defaults to `pi`.

Pi runs with the permissions of its parent process. Use a dedicated user or
container and configure `PI_WORKDIR` to an isolated repository workspace.
