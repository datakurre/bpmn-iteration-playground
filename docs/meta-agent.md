# Meta-Agent Architecture & Operating Model

**graph-agent** transforms BPMN 2.0 into an industrial-strength meta-agent controller. Rather than running bespoke, fragile Python while loops that crash on restarts, lose history, or overwrite concurrent work, graph-agent orchestrates long-running agent workflows with transactional persistence, isolated filesystem workspaces, and first-class human review gates.

---

## 1. Why BPMN for Agent Orchestration?

BPMN 2.0 provides the orchestration primitives that bespoke agent loops lack:

| Primitive | Ad-hoc Agent Loop | graph-agent BPMN Controller |
|---|---|---|
| **State Persistence** | Memory / JSON file; lost on restart | Transactional **ZODB** database (`.agents/state/Data.fs`) with automatic crash recovery |
| **Execution Steps** | Recursive prompt loops | Explicit BPMN ServiceTasks executing as step-by-step turns |
| **Subprocesses** | Custom orchestration logic | Reusable `CallActivity` fragments and dynamic event-subprocesses |
| **Branching & Variant Exploration** | Manual file copying | Transactional **SavePoints** with full state and workspace forking |
| **Human Checkpoints** | CLI `input()` blocking threads | Asynchronous `UserTask` with native **FormJS** schemas |
| **Filesystem Safety** | Unchecked in-place file modifications | **Git Worktrees** (`worktree`), auto-merge on clean completion, or in-place mutex (`in_place`) |
| **Tool Extensibility** | Hardcoded tool calling | Open **AdapterRegistry** (`harness_type`: Pi, Shell, custom tooling) |

---

## 2. Workspace Layout (`.agents/`)

Every project directory managed by `graph-agent` contains a local `.agents/` folder initialized with `graph-agent init`:

```
.agents/
  workflows/         # Editable BPMN diagrams copied from package templates
  state/             # Local ZODB storage (Data.fs and blob storage)
  worktrees/         # Git worktree checkouts for isolated graph runs
  logs/              # Structured logs (graph-agent.log, daemon.log)
  runtime.json       # Dynamic daemon handshake (PID, port, loopback auth token)
  config.toml        # Workspace settings overrides
```

---

## 3. Workspace Strategies & Concurrency

When a graph runs, turns execute against a filesystem managed by a `WorkspaceStrategy`:

1. **`WorktreeStrategy` (Git Repositories)**:
   - Allocates a dedicated Git worktree branch `bpmn/run/<run-id>` at `.agents/worktrees/<run-id>`.
   - Multiple workflow instances execute concurrently in parallel worktrees without stepping on each other's uncommitted files.
   - **Auto-Merge on Completion**: When a run finishes in `completed` state, `graph-agent` merges `bpmn/run/<run-id>` into the base branch with `--no-ff`. If the working tree is dirty or conflicts occur, the merge is deferred (`merge_deferred`) and surfaced in the TUI Inbox.
2. **`InPlaceStrategy` (Non-Git Folders)**:
   - Runs directly in the project directory.
   - Enforces a per-workspace `asyncio.Lock` mutex, guaranteeing serialized single-turn execution so agents do not interleave file writes.
3. **`BlobStrategy` (Scratch / Ephemeral Runs)**:
   - Scaffolds into an isolated temporary folder and snapshots the filesystem into compressed `tar.zst` blobs in ZODB.

---

## 4. The Per-Workspace Supervisor

A long-running supervisor process (`graph_agent/data/workflows/project.bpmn`) acts as a top-level project coordinator:

- Stays parked on an inbound message catch event (`spawn_requested`).
- Upon receiving a task brief, spawns an event-subprocess child running a full review, analysis, or code generation cycle.
- The TUI and REST API provide direct commands (`POST /project/spawn`, TUI Inbox) to dispatch tasks into the supervisor.

---

## 5. User Interfaces: TUI, CLI, and Web Studio

- **Interactive TUI**:
  - Launch with `graph-agent` or attach with `graph-agent attach`.
  - Screens: **Runs** (status overview), **Run Detail** (task timeline & streaming logs), **Inbox** (pending human tasks & deferred merges), **Form** (FormJS interactive rendering), **Start** (template launcher), and **Log** (activity tail).
- **Command Line CLI**:
  - `graph-agent run <template> --var k=v`
  - `graph-agent ls`, `graph-agent show <id>`, `graph-agent logs <id> -f`
  - `graph-agent merge <id>`, `graph-agent cancel <id>`
- **Web Studio**:
  - Run headless with `graph-agent serve --no-tui`.
  - Accessible in browser with visual BPMN diagram viewer, element templates modeler, and full timeline inspection.
