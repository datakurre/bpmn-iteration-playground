# BPMN 2.0 Orchestration & ZODB Persistence

Pi Workflow Studio combines the formal execution semantics of **BPMN 2.0** with durable **ZODB ACID storage**, ensuring that enterprise workflows, AI agent invocations, and human decisions proceed reliably without transient failures or state loss.

---

## Architecture Overview

```
+-------------------------------------------------------------+
|                      FastAPI Web Layer                      |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|                       WorkflowService                       |
|  - Manages SpiffWorkflow engine instances                   |
|  - Synchronizes task and workflow variable scope            |
|  - Dispatches agent turns via the AdapterRegistry           |
|  - Creates and manages savepoint checkpoints                |
+-------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                 +-----------------------+
|     SpiffWorkflow     |                 |     WorkflowStore     |
|   (BPMN 2.0 Engine)   |                 |     (ZODB / File)     |
+-----------------------+                 +-----------------------+
```

---

## 1. BPMN Process Definition

The contract review workflow is modeled in standard BPMN 2.0 XML located at `workflows/contract_review.bpmn`:

1. **Start Event (`StartEvent_1`)**: Accepts the initial process payload (e.g. `contract` text).
2. **Service Task (`ServiceTask_Extract`)**: Delegates contract clause extraction and risk analysis to the local Pi agent.
3. **Exclusive Gateway (`ExclusiveGateway_Success`)**: Evaluates `agent_status == 'success'` to branch execution:
   - **Success Branch**: Routes to human review user task (`ServiceTask_Review`).
   - **Failure Branch**: Routes to failure handling review task (`ServiceTask_FailureReview`).
4. **User Task (`ServiceTask_Review`)**: Waits for human operator review and decision (`approved` / `rejected`).
5. **End Event (`EndEvent_1`)**: Completes the workflow execution.

---

## 2. ZODB ACID Persistence

State persistence is managed via [`bpmn_agent/persistence.py`](../../bpmn_agent/persistence.py):

- **Storage Engine**: `ZODB.FileStorage` writing durable transaction logs to `data/workflows.fs`.
- **In-Memory Mode**: Supported for testing via `WorkflowStore(":memory:")`.
- **ACID Transactions**: Every workflow state transition, save point creation, and task completion commits cleanly through `transaction.commit()`.
- **Process Isolation**: Workflows can be paused, restarted, and inspected at any point without memory corruption.

```python
from bpmn_agent.persistence import WorkflowStore

store = WorkflowStore("data/workflows.fs")
store.save(workflow_id, instance_state)
state = store.load(workflow_id)
```

---

## 3. Scope & State Synchronization

SpiffWorkflow evaluates expressions on sequence flows (such as `agent_status == 'success'`) against the active task's data scope.

When an AI agent completes, the service synchronizes both the task's data dictionary and the parent workflow's global data dictionary:

```python
task.data.update(agent_result_data)
workflow.data.update(agent_result_data)
```

This guarantees seamless gateway routing and variable visibility across all downstream BPMN nodes.
