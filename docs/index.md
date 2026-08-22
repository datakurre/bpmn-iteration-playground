# Pi Workflow Studio

**Pi Workflow Studio** is a durable orchestration system pairing **BPMN 2.0 executable workflows** (powered by [SpiffWorkflow 3.2.0](https://github.com/sartography/SpiffWorkflow)) with **autonomous local AI agents** (run as stateless, step-by-step Pi CLI turns), **ACID-compliant ZODB persistence**, **durable save points that capture the agent's workspace**, and **FormJS human review checkpoints**.

---

## Visual Studio Tour

### 1. Studio Dashboard
The primary launchpad to select BPMN process templates, trigger new workflow executions, and monitor active review checkpoints.

![Studio Dashboard](images/studio-dashboard.png)

### 2. Live Diagram & Human Review Checkpoint
Interactive BPMN diagram visualizer highlighting active execution nodes alongside dynamic human review forms with live Markdown previews powered by `@bpmn-io/form-js`.

![Live Instance and Form Review](images/docgen-review-checkpoint.png)

### 3. Iterative Revision Loop & Workflow Completion
Full execution trace with color-coded completed task markers, iteration loops, variable state, and point-in-time save points.

![Completed Workflow Instance](images/instance-completed.png)

### 4. Process History & Analytics
Comprehensive execution history with live metric counters, duration benchmarks, and status filters.

![Process History Page](images/process-history.png)

### 5. Save Point & Variable Inspector
Visual audit trail of all intermediate save points allowing inspection of variable payloads, workspace archives, and one-click timeline forking.

![Save Point Inspector](images/savepoint-inspector.png)

### 6. Manual Save Point Retention
Save points carry a copy of the agent's workspace, so they are purged deliberately rather than by an automatic policy. Every save point offers a secondary, clearly destructive **Purge** action that confirms by naming the anchor element and the exact number of save points it will delete.

![Save Point Purge](images/savepoint-purge.png)

### 7. Workspace File Inspection
Files the agent wrote are packed into a ZODB Blob and listed per instance, with any single file viewable on demand without unpacking the whole archive.

![Workspace Files Panel](images/instance-workspace-files.png)

### 8. Long-Running Projects & Spawned Children
A **Project** is an ordinary long-running BPMN process that parks on a human task and spawns one child per `spawn_requested` message, staying open while children run and complete.

![Project With Spawned Children](images/project-spawn.png)

---

## Core Capabilities

```mermaid
graph LR
    A[BPMN Process Start] --> B[SpiffWorkflow Engine]
    B -->|Persist State| C[(ZODB Storage)]
    B -->|Stateless JSON-mode turn| D[Local Pi AI Agent]
    D -->|Structured Findings| B
    B -->|Save Point: before/after harness| E[Durable Save Points]
    B -->|FormJS Human Checkpoint| F[Human Reviewer]
    F -->|Approved / Rejected| B
    B --> G[Process Completed]
    E -->|Fork & Branch| B
```

- **Executable BPMN 2.0 Processes**: Industrial-grade business process orchestration with conditional gateways, service tasks, and user tasks.
- **Local Pi AI Agent Integration**: Stateless, step-by-step CLI turns (`pi --mode json -p …`) with a validated JSON output contract, `session_id` continuation across turns, automatic fallback demo mode, and proxy-based secret injection.
- **ZODB ACID Durability**: Safe file-backed database (`data/workflows.fs`) or memory storage guaranteeing zero state loss across process restarts.
- **Save Points & Timeline Forking**: Automatic snapshotting at critical execution boundaries (`before_harness`, `after_harness`, `human_wait`), each carrying an independent copy of the agent's workspace, enabling faithful state rewinds and parallel what-if branches.
- **Manual Save Point Retention**: Purge is anchored on a BPMN element and always confirmed — never a scheduled or automatic expiry, because only a person can judge which past states are still worth forking from.
- **Long-Running Projects**: Native BPMN event subprocesses spawn one child instance per message, so a Project can fan out unbounded work while remaining open and resumable.
- **FormJS Human Review Checkpoints**: Rich form rendering with dynamic field validation, allowing human operators to inspect AI findings and submit continuation decisions.
- **History & Data Lifecycle**: Full execution auditing, status filtering, variable payload inspection, and direct historical record removal.

---

## Quick Navigation

- [End-to-End Usage Story & Live Walkthrough](usage-story.md)
- [BPMN Orchestration & ZODB](features/orchestration.md)
- [Pi AI Agent Integration](features/ai-agent-integration.md)
- [Save Points & Timeline Forking](features/savepoints-forking.md)
- [Web Interface & FormJS](features/web-ui.md)
- [Process History & Analytics](features/history-analytics.md)
- [Authoring Workflows: input/output mappings and spawning](authoring-workflows.md)
- [Developer & Getting Started Guide](development/getting-started.md)
- [Testing & Screenshot Automation](development/testing-verification.md)
