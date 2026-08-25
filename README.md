# graph-agent

**graph-agent** is a durable BPMN 2.0 orchestration engine and agent runtime. It replaces bespoke, fragile agentic loops with structured, durable BPMN workflows without reinventing the agent atoms.

- **Durable Orchestration**: Built on [SpiffWorkflow](https://spiffworkflow.org/) with per-workspace local **ZODB** persistence.
- **Agent Turns as Tasks**: Service tasks dispatch to local AI agent harnesses (such as [Pi](https://github.com/badlogic/pi-mono)) or deterministic tools ([ShellAdapter](graph_agent/adapters/shell_adapter.py)).
- **Isolated Workspace Strategies**:
  - `worktree`: Runs each graph on an isolated Git worktree branch (`bpmn/run/<id>`) with auto-merge on clean completion.
  - `in_place`: Serialized in-place execution with concurrency mutex for non-Git repositories.
  - `blob`: Ephemeral workspace snapshots stored directly in ZODB.
- **Interactive TUI & Web Studio**: Terminal user interface ([Textual](https://textual.textualize.io/)) and web dashboard with visual BPMN viewer, FormJS human checkpoints, and SavePoint branch/forking.
- **CLI Suite**: Full set of verbs to run, inspect, follow, cancel, merge, and manage workflows.

---

## Quick Start

### 1. Initialize a Workspace
Initialize `.agents/` in any project folder:

```bash
graph-agent init
```

This creates the workspace structure:
- `.agents/workflows/`: Editable BPMN workflow templates.
- `.agents/state/`: Local ZODB workflow database (`Data.fs`).
- `.agents/worktrees/`: Git worktrees for isolated parallel executions.
- `.agents/logs/`: Daemon and activity logs.

### 2. Launch the TUI
Run `graph-agent` with no arguments to start or attach to the local daemon and open the interactive TUI:

```bash
graph-agent
```

Or attach to an already-running daemon:

```bash
graph-agent attach
```

### 3. Headless Daemon Mode
To run the daemon in the background or headlessly:

```bash
graph-agent serve --no-tui
```

---

## Command Line Interface (CLI)

`graph-agent` (or `bpmn`) provides a complete set of commands:

```bash
# Start a new workflow run
graph-agent run plan_and_execute.bpmn --var goal="Implement user authentication"

# List all active and historical runs
graph-agent ls
graph-agent ls --all

# View details of a specific workflow run
graph-agent show <run-id>

# View or follow streaming logs of a run
graph-agent logs <run-id> -f

# Merge a completed run branch into the base branch
graph-agent merge <run-id>

# Cancel a running workflow
graph-agent cancel <run-id>

# Check daemon status or open web UI
graph-agent status
graph-agent open
graph-agent stop
```

---

## Interactive Terminal UI (TUI)

The TUI provides 6 purpose-built screens:

1. **Runs Screen**: Overview of active, completed, and waiting workflows with status, current task, elapsed time, and merge state.
2. **Run Detail Screen**: Task timeline, streaming agent/shell output logs, workflow data inspector, and savepoint checkpoints.
3. **Inbox Screen**: Cross-graph aggregator for pending human tasks (`waiting_human`) and deferred merges (`merge_deferred`).
4. **Form Screen**: Native interactive rendering of FormJS schemas (`textfield`, `textarea`, `number`, `checkbox`, `select`, `radio`) with a fallback deep-link to the browser.
5. **Start Screen**: Template chooser listing `.agents/workflows/` with variable prompt fields.
6. **Log Screen**: Live auto-scrolling tail of workspace activity logs.

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
devenv shell

# Run full test suite (400+ tests)
pytest tests/

# Strict type checking
mypy --strict graph_agent/

# Linter and formatter
ruff check graph_agent/ tests/
```
