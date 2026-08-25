# BPMN Pi Workflow

A personal, iterative digital design and manufacturing pipeline: BPMN 2.0 processes are the
controller for agent work, replacing bespoke agentic loops without reinventing their atoms —
Pi stays the agent runtime. BPMN contributes what an ad hoc loop doesn't: durable state,
composable/reusable pipeline fragments (`CallActivity`), human-in-the-loop checkpoints
(FormJS forms), and branchable history (savepoint fork — try a design variant from any past
step). Orchestration is decoupled from the agent runtime through the adapter registry
(`harness_type` → adapter), so future pipeline steps — a slicer, CAM tool, or other non-LLM
process — plug in the same way Pi does, without engine changes.

FastAPI persists SpiffWorkflow instances in ZODB and orchestrates AI service tasks
as stateless, step-by-step turns via Pi's non-interactive JSON print mode (`--mode json -p <prompt>`),
preserving context across turns by propagating `session_id`.

## Run

```bash
devenv up -d
devenv processes wait
```

Open `http://127.0.0.1:8000/` for the Workflow Studio dashboard. Start a
workflow with `POST /workflow/start`, or use the dashboard. Pi tasks run in a
local non-interactive CLI subprocess and return a validated JSON contract. Human tasks remain
waiting until `POST /workflow/{workflow_id}/submit-task/{task_id}` is called.
Failed Pi tasks remain persisted with their failure reason until the user
presses `Retry` in the instance UI or calls the retry endpoint.

Service tasks publish their results to the workflow only through declared
`camunda:outputParameters`, so gateways route on task-scoped names
(`plan_status == 'success'`) and parallel agent turns cannot overwrite each other.

A graph can also wait on the outside world: a message catch event parks the instance
until `POST /instance/{instanceId}/message/{name}` delivers a payload, and timer events
fire from a background ticker (`TIMER_TICK_SECONDS`, `0` disables). See
`bpmn_agent/data/workflows/external_gate.bpmn`. `bpmn_agent/data/workflows/composed_delivery.bpmn` shows a whole
agent-plus-human cycle reused as a single CallActivity node.

Each persisted instance has stateful routes under `/instance/{instanceId}`:
`/state`, `/diagram`, `/form/{taskId}`, and `/submit-task/{taskId}`. The
`/instance/{instanceId}` page renders the persisted BPMN XML with local
`bpmn-js` assets and highlights active tasks. `/admin` lists and deletes stored
instances; set `ADMIN_TOKEN` to require an `X-Admin-Token` header.

Every wait boundary creates a durable save point: `before_harness`,
`after_harness`, and `human_wait` where applicable. The instance page exposes a
`Fork` action for each save point. Forking before the harness reruns Pi;
forking after the harness resumes orchestration without rerunning Pi.

## Deterministic steps: the shell harness

Not every node in a pipeline is an agent. A task with `harness_type: shell` runs a command
declared in its BPMN properties inside the instance workspace, and publishes the result
through the same output contract agent tasks use:

```xml
<camunda:property name="harness_type" value="shell" />
<camunda:property name="command" value="make pdf" />
<camunda:property name="artifacts" value="slides.pdf" />
<camunda:property name="fail_on_error" value="false" />
```

The command never comes from workflow data — only from the diagram — because workflow data
is largely agent-written. `fail_on_error="false"` is the interesting part: a non-zero exit
then completes the turn with `${status}` set to `failed` instead of halting the instance, so
a gateway can *route* on the failure. That turns a compiler into a participant in the loop.

`bpmn_agent/data/workflows/beamer_slides.bpmn` is the worked example: an agent plans a deck outline, a human
settles the outline, `template="beamer"` scaffolds a pinned TeX Live toolchain
(`bpmn_agent/data/workspace_templates/beamer/` — `texliveBasic.withPackages` + a `Makefile`), an agent writes
`slides.tex`, and `make pdf` compiles it. If LaTeX rejects the deck the instance parks on a
diagnosis gate with the log, where you either hand it back to the slide agent for another
attempt or abandon the deck — a build the agent cannot fix costs one turn, not an unbounded
spiral. Once it compiles, `make images` renders one PNG per slide, so the human reviews the
deck as it actually looks rather than approving source.

For a deterministic local showcase without model credentials:

```bash
devenv processes down
devenv shell -- demo
```

The demo command uses `bpmn_agent/data/pi-demo` as a deterministic CLI mock. The
normal devenv installs the pinned Pi CLI at `node_modules/.bin/pi` and points
`PI_EXECUTABLE` there automatically.

## Pi Variants

The flake packages focused wrappers around the local Pi CLI:

```bash
nix run .#pi-bpmn-json-form-builder -- "Build a Camunda form"
nix run .#pi-text-analysis -- "Analyze this text"
nix run .#pi-contract-review -- "Review this contract"
nix run .#pi-beamer-author -- "Turn outline.md into slides.tex"
```

Each wrapper supplies a task-specific system prompt and tool allowlist. The
underlying executable is selected with `PI_EXECUTABLE` and defaults to `pi`.

Pi runs with the permissions of its parent process. Use a dedicated user or container.
Each instance gets its own unpacked workspace; `PI_WORKDIR` is an optional template
directory copied into a fresh workspace, not the directory the agent runs in.

A failed Pi run only retries against the demo mock when `PI_ALLOW_DEMO_FALLBACK=1`.
Leave it off in any deployment where a fabricated agent result would be acted on.
