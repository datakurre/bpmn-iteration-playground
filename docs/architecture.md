# Architecture Overview

> AGENTS.md's "Architecture & Module Map" is the file-by-file reference; this document details the core subsystems (workspace strategies, savepoints, concurrency, TUI/CLI, and Project supervisors).

**graph-agent** is a durable BPMN 2.0 orchestration engine combining local AI execution with transactional persistence, isolated workspace strategies, and human-in-the-loop task forms.

```mermaid
flowchart TD
    Client[TUI / CLI / Web UI] --> Daemon[FastAPI Local Daemon]
    Daemon --> Service[WorkflowService]
    Service --> Runner[WorkflowRunner / SpiffWorkflow]
    Service --> Strategy[WorkspaceStrategy: Worktree | InPlace | Blob]
    Service --> Registry[AdapterRegistry]
    Registry --> PiAdapter[PiAdapter / PiClient]
    Registry --> SandboxAdapter[SandboxPiAdapter]
    Registry --> ShellAdapter[ShellAdapter]
    Registry --> MockAdapter[MockAdapter]
    PiAdapter --> Subprocess[Pi CLI Subprocess]
    Service --> Store[WorkflowStore / ZODB]
    Store --> StateDir[.agents/state/Data.fs]
    Service --> EventBus[EventBus & Webhooks]
```

---

## Core Subsystems

### 1. BPMN Engine & Execution Scope
- Powered by **SpiffWorkflow 3.2.0**, diagrams loaded from `.agents/workflows/*.bpmn` (or bundled templates).
- Instances persisted across versions are upgraded on read by `graph_agent/migrations.py` (`migrate_workflow_object`), which is idempotent and runs on both `load()` and `load_save_point()`.
- Service tasks declare their AI harness via `camunda:properties` (`harness_type="pi_agent"` and `agent_role="code_reviewer"`).
- Exclusive gateways evaluate Python expressions against merged `task.data` and `workflow.data` (e.g. `agent_status == 'success'`).
- A `subProcess triggeredByEvent="true"` with a message start event spawns one **child instance per caught message**, letting a long-running supervisor process fan out work while staying open.

### 2. Workspace Strategies
Each workflow instance executes turns under a selected `WorkspaceStrategy` (`graph_agent/workspace_strategy.py`):

1. **`WorktreeStrategy` (Default in Git repositories)**:
   - Creates a dedicated Git worktree branch (`bpmn/run/<id>`) rooted at `.agents/worktrees/<id>`.
   - Allows fully concurrent, isolated graph runs without filesystem collisions.
   - **Auto-Merge on Clean Completion**: Automatically executes `git merge --no-ff bpmn/run/<id>` into the base branch upon successful completion if the working tree is clean. If dirty or in conflict, status becomes `merge_deferred` and surfaces in the TUI Inbox / web UI for manual resolution.
2. **`InPlaceStrategy` (Default in non-Git directories)**:
   - Executes turns directly in the workspace root directory.
   - Enforces a per-workspace `asyncio.Lock` mutex to serialize executions and prevent conflicting edits.
3. **`BlobStrategy` (Scratch / Template runs)**:
   - Creates an ephemeral scratch directory and snapshots state as compressed `tar.zst` blobs in ZODB.

### 3. Persistence Layer (ZODB Local to Workspace)
- **WorkflowStore** manages ACID persistence backed by ZODB (`Data.fs`), local to `.agents/state/`.
- Metastore tree maintains lightweight summaries (`WorkflowMetadata`) with indexing and pagination for fast querying without loading complete execution graphs.

### 4. Pi AI Agent & Shell Harnesses
- **PiClient**: Invokes the Pi agent as a non-interactive CLI subprocess (`pi --mode json -p <prompt>`).
- Turns are **step-by-step**. Context propagates across turns via `session_id` (`--session`, or `--fork` when a savepoint fork branches the session), tracked in `workflow.data["__sessions"]`.
- Standard 5-key JSON output contract:
  ```json
  {
    "status": "success",
    "summary": "Analysis findings",
    "findings": ["item 1", "item 2"],
    "artifacts": ["document.md"],
    "next_action": "continue"
  }
  ```
- **ShellAdapter**: Executes declared shell commands inside the workspace as deterministic steps (e.g., compiling LaTeX or running build tools).

### 5. Savepoints & Timeline Forking
- Automated savepoints captured at durable boundaries:
  - `before_harness`: Prior to launching an agent subprocess.
  - `after_harness`: Immediately upon successful completion of an agent step.
  - `human_wait`: When execution enters a `UserTask`.
- Any savepoint can be branched via `POST /instance/{id}/fork/{savepoint_id}`, creating a new execution branch inheriting history.

### 6. Terminal User Interface (TUI) & Daemon Client
- **`DaemonClient`** (`graph_agent/tui/client.py`): Talks over HTTP REST and WebSocket to the local daemon, authenticated via the workspace loopback token in `.agents/runtime.json`.
- **Textual Screens**:
  - `Runs`: Live overview table of all runs.
  - `RunDetail`: Timeline, execution logs, workflow variables, and savepoints.
  - `Inbox`: Aggregates pending human tasks and deferred merges across all runs.
  - `Form`: Native FormJS schema renderer.
  - `Start`: Template picker and variable launcher.
  - `Log`: Live streaming tail of workspace activity logs.

### 7. Bounded Turn Concurrency & Restart Durability
- Concurrency bounded via `asyncio.Semaphore(max_parallel_turns)` in `jobs.dispatch`.
- `recover_orphaned_workflows()` runs on daemon start to reclaim orphaned worktrees and mark abandoned in-flight tasks cleanly.
