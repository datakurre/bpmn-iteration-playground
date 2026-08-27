# BPMN 2.0 Orchestration & ZODB Persistence

**graph-agent** combines the formal execution semantics of **BPMN 2.0** with durable **ZODB ACID storage** local to the workspace (`.agents/state/Data.fs`), ensuring that long-running workflows, AI agent turns, and human decisions proceed reliably across process restarts.

---

## Architecture Overview

```
+-------------------------------------------------------------+
|                     FastAPI Local Daemon                    |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|                       WorkflowService                       |
|  - Manages SpiffWorkflow engine instances                   |
|  - Selects WorkspaceStrategy (Worktree / InPlace / Blob)    |
|  - Synchronizes task scope via outputParameters             |
|  - Dispatches turns via AdapterRegistry                     |
|  - Captures durable SavePoint checkpoints                   |
+-------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                 +-----------------------+
|     SpiffWorkflow     |                 |     WorkflowStore     |
|   (BPMN 2.0 Engine)   |                 | (.agents/state/Data.fs|
+-----------------------+                 +-----------------------+
```

---

## 1. BPMN Process Definition

Workflows are standard BPMN 2.0 XML files placed in `.agents/workflows/` (or bundled templates):

1. **Start Event**: Accepts the initial process payload (e.g. `goal` text).
2. **Service Task**: Delegates execution to an adapter (`harness_type="pi_agent"` or `shell`).
3. **Exclusive Gateway**: Evaluates boolean conditions (e.g. `agent_status == 'success'` or `plan_status == 'success'`) to branch execution.
4. **User Task**: Waits for human review and decisions with native FormJS schemas.
5. **End Event**: Completes the workflow run, triggering auto-merge under `WorktreeStrategy`.

---

## 2. ZODB ACID Persistence

State persistence is managed via [`graph_agent/persistence.py`](file:///workspace/graph-agent/graph_agent/persistence.py):

- **Storage Engine**: `ZODB.FileStorage` writing transaction logs to `.agents/state/Data.fs`.
- **In-Memory Mode**: Supported for testing via `WorkflowStore(":memory:")`.
- **ACID Transactions**: Every workflow state transition, savepoint creation, and task completion commits cleanly through `transaction.commit()`.
- **Metadata Indexing**: Lightweight metadata records (`WorkflowMetadata`) support rapid pagination and history queries without loading complete SpiffWorkflow object graphs.

---

## 3. Scoped Variable Publication

Service tasks publish variables to the workflow exclusively through declared `camunda:outputParameters`. This prevents parallel agent branches from overwriting each other's verdicts and isolates task telemetry to `job` records while publishing cleanly to `task.data` and `workflow.data`.

---

## 4. In-Flight Spec Replacement & Dynamic Graph Extension

### Dynamic BPMN Spec Replacement (`replace_spec`)
Running workflow instances can migrate their BPMN 2.0 XML spec dynamically without discarding active execution state:
- **Active Task Preservation**: Runtime tasks in non-future states (`READY`, `STARTED`, `COMPLETED`, `WAITING`) are matched and repointed to their corresponding new `TaskSpec` definitions.
- **Predicted Tasks Purge**: Untriggered future tasks are globally purged and re-predicted from the new specification graph (`workflow._predict()`).
- **SavePoint Checkpoint**: A durable savepoint (`phase="spec_replaced"`) is committed to ZODB upon migration.
- **Mid-Execution Protection**: Rejects external replacements with `409 Conflict` while turns are actively running (`waiting_pi`, `running`, `retry_requested`).

### Dynamic Graph Extension (`extend_graph`)
Workflows can dynamically extend themselves at runtime:
- **Programmatic Splicing**: Slices new nodes between existing elements (`insert_nodes`) and rewires incoming/outgoing sequence flows.
- **Self-Extending Bootstrap Meta-Loop**: Shipped with `graph_agent/data/workflows/bootstrap.bpmn` where an Architect AI agent plans graph extensions, a human reviewer gates the proposal, and `GraphExtendAdapter` (`harness_type: graph_extend`) executes the extension in-flight.
