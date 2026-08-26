# BPMN Modeling Best Practices for AI Agents

These guidelines ensure that generated BPMN 2.0 workflow diagrams are syntactically valid, visually readable, semantically unambiguous, and fully executable in `graph-agent`.

---

## 1. Flow Direction and Layout

- **Model Strictly Left-to-Right**: Primary sequence flows should move from left to right. Avoid backward flows except for explicit iteration / retry loops.
- **Use Automated Layout**: Run `layout-bpmn.js` or `craft-bpmn.js` to compute `bpmndi:BPMNDiagram` coordinates. Never guess pixel coordinates manually.
- **Symmetry**: Keep split and join gateway pairs aligned and balanced.

---

## 2. Naming Conventions

Clear labels make workflow diagrams self-explanatory:

| Element Type | Convention | Example |
| :--- | :--- | :--- |
| **Tasks (`bpmn:serviceTask`, `bpmn:userTask`)** | Imperative Verb + Object | `"Plan Implementation"`, `"Compile LaTeX"`, `"Review Signoff"` |
| **Events (`bpmn:startEvent`, `bpmn:endEvent`)** | Object + State (Past Participle) | `"Issue Ingested"`, `"Patch Applied"`, `"Build Verified"` |
| **Gateways (`bpmn:exclusiveGateway`)** | Question ending with `?` | `"Tests Passed?"`, `"Approved?"`, `"Fix Succeeded?"` |
| **Sequence Flows (from Gateways)** | Condition / Outcome Name | `"Yes"`, `"No"`, `"Success"`, `"Failed"`, `"Changes Requested"` |

---

## 3. Gateway and Branching Rules

- **Always Use Explicit Gateways**: Never attach `<bpmn:conditionExpression>` directly to a sequence flow originating from a Task. Always place an `<bpmn:exclusiveGateway>` after the task.
- **Condition Expressions**: Condition expressions in SpiffWorkflow evaluate python-style variable comparisons against task/workflow variables:
  ```xml
  <bpmn:sequenceFlow id="Flow_OK" name="Approved" sourceRef="GW_Check" targetRef="Task_Next">
    <bpmn:conditionExpression>plan_status == 'success'</bpmn:conditionExpression>
  </bpmn:sequenceFlow>
  ```
- **Every Branch Must Terminate or Join**: Avoid dead ends. Every path out of a gateway must either lead to an explicit `<bpmn:endEvent>` or join into a convergence gateway.

---

## 4. Loop and Retry Boundaries

- **Avoid Unbounded Loops**: Never create a circular sequence flow without a guaranteed termination condition (such as an iteration counter or a human decision gate).
- **Human-in-the-Loop on Failure**: When a step fails (e.g. LaTeX compile fails or test fails), route to a UserTask gate holding the failure log `${build_log}` so human intervention can decide whether to retry or abort.

---

## 5. Explicit Variable Scoping

- **Declare All Inputs and Outputs**: Never rely on implicit variable leakage.
- **Task Scoping Isolation**: Parallel tasks should publish to distinct variable names (e.g. `plan_status` vs `impl_status`) to prevent race conditions or overwrite bugs.
