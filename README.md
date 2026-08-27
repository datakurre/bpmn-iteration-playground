# graph-agent

**graph-agent** (`bpmn`) is a durable BPMN 2.0 orchestration engine and agent runtime. It replaces bespoke, fragile agentic loops with structured, durable BPMN workflows without reinventing the agent atoms.

- **API-First Architecture**: Canonical **FastAPI** REST and WebSocket API backing the CLI, the interactive Terminal UI (TUI), and the browser-based Workflow Studio.
- **Durable Orchestration**: Built on [SpiffWorkflow](https://spiffworkflow.org/) with per-workspace local **ZODB** ACID persistence.
- **In-Flight Spec Replacement & Dynamic Graph Extension**:
  - Replace BPMN spec XML in-flight with execution state preservation (`PUT /instance/{id}/spec`).
  - Atomically splice new service tasks and user tasks into running graphs (`POST /instance/{id}/extend`).
  - Self-extending bootstrap meta-workflows using `GraphExtendAdapter` (`harness_type: graph_extend`).
- **Agent Turns as Tasks**: Service tasks dispatch to local AI agent harnesses (such as [Pi](https://github.com/badlogic/pi-mono)), deterministic tools ([ShellAdapter](graph_agent/adapters/shell_adapter.py)), or meta-graph extenders ([GraphExtendAdapter](graph_agent/adapters/graph_extend_adapter.py)).
- **Isolated Workspace Strategies**:
  - `worktree`: Runs each graph on an isolated Git worktree branch (`bpmn/run/<id>`) with auto-merge on clean completion.
  - `in_place`: Serialized in-place execution with concurrency mutex for non-Git repositories.
  - `blob`: Ephemeral workspace snapshots stored directly in ZODB.
- **Interactive TUI & Web Studio**:
  - Terminal User Interface ([Textual](https://textual.textualize.io/)) with full screen navigation, live output logs, FormJS form handling, and web shortcuts.
  - Web dashboard with interactive BPMN diagram viewer, visual modeler, FormJS human checkpoints, and SavePoint branch/forking.
- **CLI Suite**: Complete set of verbs to run, inspect, follow, cancel, merge, edit, and manage workflows.

---

## Quick Start

### 1. Initialize a Workspace
Initialize `.agents/` in any project folder:

```bash
graph-agent init
# or
bpmn init
```

This creates the workspace structure:
- `.agents/workflows/`: Editable BPMN workflow templates.
- `.agents/state/`: Local ZODB workflow database (`Data.fs`).
- `.agents/worktrees/`: Git worktrees for isolated parallel executions.
- `.agents/logs/`: Daemon and activity logs.

### 2. Launch the TUI
Run `graph-agent` (or `bpmn`) with no arguments to start the local daemon in the background and open the interactive TUI:

```bash
graph-agent
```

Or explicitly attach to an already-running daemon:

```bash
graph-agent attach
```

### 3. Headless Daemon Mode
To run the daemon in the foreground headlessly (without TUI):

```bash
graph-agent serve --no-tui
```

---

## Command Line Interface (CLI)

`graph-agent` (or `bpmn`) provides a complete set of commands:

```bash
# Start a new workflow run with flags
bpmn run plan_and_execute.bpmn --var goal="Implement user authentication" --model gpt-5.6-luna --workspace-mode worktree

# List active workflow runs (default) or all historical runs (-a / --all)
bpmn ls
bpmn ls --all

# View details of a specific workflow run
bpmn show <run-id>

# View or follow streaming logs of a run
bpmn logs <run-id> -f

# Merge a completed run branch into the base branch
bpmn merge <run-id>

# Cancel a running workflow
bpmn cancel <run-id>

# Open the BPMN Modeler in your default browser
bpmn edit                     # opens editor dashboard
bpmn edit contract_review     # opens specific template

# Check daemon status or open web UI
bpmn status
bpmn open                     # opens dashboard
bpmn open --editor [template] # opens editor
bpmn stop
```

### CLI Engine & Model Flags

The following flags can be passed to `graph-agent`, `graph-agent serve`, and `graph-agent run`:

| Flag | Equivalent Env Var | Default | Description |
|---|---|---|---|
| `--model <name>` | `PI_MODEL` | `gpt-5.6-luna` | Target model for AI agent turns |
| `--provider <name>` | `PI_PROVIDER` | `opencode-go` | Provider endpoint (e.g. `opencode-go`, `openai`) |
| `--executable <path>`| `PI_EXECUTABLE` | `node_modules/.bin/pi` | Path to Pi CLI executable |
| `--timeout <sec>` | `PI_TIMEOUT_SECONDS` | `1800` | Turn execution timeout in seconds |
| `--offline` | `PI_OFFLINE` | `false` | Force deterministic demo mock runner without LLM credentials |
| `--max-parallel-turns <n>` | `MAX_PARALLEL_TURNS` | `4` | Maximum concurrent active agent turns |
| `--workspace-mode <mode>` | `WORKSPACE_MODE` | `worktree` / `in_place` | Workspace strategy (`worktree`, `in_place`, `blob`) |
| `--no-merge` | `MERGE_ON_COMPLETE` | `false` | Disable auto-merge on clean completion |
| `--timer-interval <sec>`| `TIMER_TICK_SECONDS` | `10` | BPMN timer tick interval (`0` disables) |
| `--log-level <level>` | `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warning`, `error`) |

---

## Interactive Terminal UI (TUI)

The TUI is an API-first Textual application communicating over HTTP and WebSockets with the daemon:

### Global Navigation
- `1`: **Runs Screen**
- `2`: **Inbox Screen**
- `3`: **Start Screen**
- `4`: **Logs Screen**
- `q`: **Quit TUI**

### Purpose-Built Screens
1. **Runs Screen (`1`)**: Overview of active and completed workflows.
   - `Enter` / `d`: View Run Details
   - `i`: Jump to Inbox
   - `s`: Start New Workflow
   - `e`: Open BPMN Modeler in Browser
   - `r`: Refresh List
   - `m`: Merge Completed Branch
   - `c`: Cancel Run
2. **Run Detail Screen**: Tabbed inspection with Timeline, Live Logs, Workflow Data JSON, and SavePoints.
   - `t`: Retry Failed Task
   - `w`: Open Instance in Web UI
   - `m`: Merge Branch
   - `c`: Cancel Run
   - `b` / `Esc`: Back to Runs
3. **Inbox Screen (`2`)**: Cross-graph aggregator for pending human review tasks (`waiting_human`) and deferred merges (`merge_deferred`).
   - `Enter`: Open Action / Form
   - `r`: Refresh
4. **Form Screen**: Native interactive FormJS schema rendering (`textfield`, `textarea`, `number`, `checkbox`, `select`, `radio`) with value capture.
   - `Submit Form`: Submit review decision and data to workflow
   - `o`: Open in Browser
   - `b` / `Esc`: Cancel / Back
5. **Start Screen (`3`)**: Template picker from `.agents/workflows/` with custom goal and variable prompt inputs.
6. **Log Screen (`4`)**: Non-blocking asynchronous live tailing of daemon and activity logs.

---

## Workspace Strategies

Workflows configure how their filesystem is managed via `workspace_mode` (in template properties, `config.toml`, or automatically inferred):

| Mode | Applicable When | Isolation | Concurrency | Branch / Merge |
|---|---|---|---|---|
| `worktree` | Git repository | Isolated Git worktree | Full turn parallelism | Creates `bpmn/run/<id>`, auto-merges on clean completion |
| `in_place` | Any directory | Direct project root | Serialized via workspace mutex | Direct edits in workspace, no Git branches |
| `blob` | Scratch / ephemeral runs | Temporary directory | Fully isolated | Packed as `tar.zst` blobs in ZODB |

---

## Development

To develop and test `graph-agent` itself:

```bash
# Enter development shell with Python, Node, and toolchains
nix develop

# Run full test suite (400+ tests)
pytest tests/

# Strict type checking
mypy graph_agent/

# Linter and formatter
ruff check graph_agent/ tests/

# Verify web UI headlessly
playwright-python scripts/verify_instance_ui.py
```

