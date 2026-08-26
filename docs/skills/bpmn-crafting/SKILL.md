---
name: bpmn-crafting
description: Design, craft, mutate, auto-layout, and verify executable BPMN 2.0 workflow diagrams with Camunda 7 extensions and opinionated bpmnlint verification for Pi coding agent harnesses. Trigger when building workflows, authoring multi-step agent pipelines, adding human review gates, integrating deterministic shell steps, or modifying .bpmn files.
compatibility: opencode
metadata:
  workflow: bpmn-workflow-authoring
  audience: coding-agents-and-developers
---

# BPMN Crafting Skill

This skill equips agents with the tools, rules, and best practices to dynamically generate, modify, auto-layout, and lint BPMN 2.0 workflows with Camunda 7 extensions for execution by `graph-agent` and SpiffWorkflow.

---

## 1. Quick Start: Crafting a Workflow

To generate a fully formatted, auto-layouted, and pre-linted BPMN diagram, run `craft-bpmn.js`:

```bash
# Using a canonical recipe:
node docs/skills/bpmn-crafting/scripts/craft-bpmn.js \
  --recipe agent-human-gate \
  --id my_review_flow \
  --name "Feature Review Flow" \
  --out graph_agent/data/workflows/my_review_flow.bpmn

# Or using a custom JSON specification:
node docs/skills/bpmn-crafting/scripts/craft-bpmn.js \
  --spec my_spec.json \
  --out graph_agent/data/workflows/my_custom_flow.bpmn
```

---

## 2. The BPMN Crafting Lifecycle

Follow this 4-step cycle whenever creating or modifying a BPMN workflow:

```
┌─────────────────┐     ┌───────────────────┐     ┌───────────────────┐     ┌────────────────────┐
│ 1. Build Graph  │ ──> │ 2. Auto-Layout    │ ──> │ 3. Lint & Validate│ ──> │ 4. Spiff Verify    │
│ (craft-bpmn.js) │     │ (layout-bpmn.js)  │     │ (lint-bpmn.js)    │     │ (verify-spiff.py)  │
└─────────────────┘     └───────────────────┘     └───────────────────┘     └────────────────────┘
```

1. **Build Graph**: Declare process nodes (Start, ServiceTasks, ExclusiveGateways, UserTasks, EndEvents) and sequence flows.
2. **Auto-Layout**: Compute diagram interchange (DI) coordinates and routing waypoints using `bpmn-auto-layout`.
3. **Lint & Validate**: Run opinionated `bpmnlint` checks + Camunda 7 engine invariants via `lint-bpmn.js`.
4. **Spiff Verify**: Verify execution compatibility with `graph_agent.engine.WorkflowRunner` via `verify-spiff.py`.

---

## 3. Tool Reference

### `lint-bpmn.js` — Linting & Semantic Verification
Runs `bpmnlint:recommended` (with opinionated adjustments) and custom Camunda extension validators.

```bash
# Lint a single file
node docs/skills/bpmn-crafting/scripts/lint-bpmn.js graph_agent/data/workflows/plan_and_execute.bpmn

# Lint multiple files with JSON output
node docs/skills/bpmn-crafting/scripts/lint-bpmn.js --glob "graph_agent/data/workflows/*.bpmn" --json

# Lint and automatically fix missing or broken layout coordinates
node docs/skills/bpmn-crafting/scripts/lint-bpmn.js my_flow.bpmn --fix-layout
```

### `layout-bpmn.js` — Automated Diagram Layout
Generates clean `<bpmndi:BPMNDiagram>` shapes, bounding boxes, and sequence flow waypoints.

```bash
node docs/skills/bpmn-crafting/scripts/layout-bpmn.js input.bpmn output.bpmn
# Or in-place:
node docs/skills/bpmn-crafting/scripts/layout-bpmn.js --in-place my_workflow.bpmn
```

### `craft-bpmn.js` — Programmatic Generator
Generates BPMN XML from recipes or JSON specs.

```bash
node docs/skills/bpmn-crafting/scripts/craft-bpmn.js --recipe agent-shell-verify --out workflow.bpmn
```

### `verify-spiff.py` — Engine Compatibility Test
Parses the workflow using `WorkflowRunner` to verify SpiffWorkflow and extension binding compatibility.

```bash
.venv/bin/python3 docs/skills/bpmn-crafting/scripts/verify-spiff.py graph_agent/data/workflows/my_flow.bpmn
```

---

## 4. Key Modeling Rules & Invariants

1. **Process Must Be Executable**: Root `<bpmn:process>` must have `isExecutable="true"`.
2. **Left-to-Right Flow**: Sequence flows should flow left to right.
3. **Explicit Gateways**: Never attach conditions directly to task sequence flows. Always use an `<bpmn:exclusiveGateway>` with condition expressions on its outgoing flows.
4. **Condition Syntax**: Condition expressions evaluate Python-style variable comparisons against workflow data:
   ```xml
   <bpmn:conditionExpression>status == 'success'</bpmn:conditionExpression>
   ```
5. **Harness Configuration**: Every `<bpmn:serviceTask>` must define `harness_type` in `<camunda:properties>`:
   - `pi_agent` / `sandbox_pi`: AI coding agent (specify `agent_role`)
   - `shell` / `sandbox_shell`: Deterministic command execution (specify `command`, optionally `fail_on_error="false"`)
   - `mock_agent`: In-memory test stub
6. **Explicit Variable Scoping**:
   - Injected prompt data is declared via `<camunda:inputParameter>`.
   - Published results are declared via `<camunda:outputParameter>`.
   - `resolve_input` only supports dotted dictionary lookups (`${var.prop}`) and literal string interpolation (`no eval`).
7. **FormJS Human Tasks**: Every `<bpmn:userTask>` should have `<camunda:formData>` with valid field types (`string`, `enum`, `textarea`, `markdown`, `boolean`, `number`, `date`).

---

## 5. Canonical Graph Patterns

### Pattern A: Agent Turn with Human Review Gate
```
[Start] ──> [ServiceTask: Pi Agent] ──> [GW: OK?] ── (Success) ──> [UserTask: Signoff] ──> [End: Done]
                                            │
                                            └─── (Failed) ───> [End: Failed]
```

### Pattern B: Agent Code Generation with Shell Verification
```
[Start] ──> [Pi Agent: Generate] ──> [Shell: Test/Compile] ──> [GW: Passed?] ── (OK) ──> [UserTask: Review] ──> [End]
                                                                     │
                                                                     └── (Fail) ──> [End: Build Broke]
```

### Pattern C: Multi-Agent Pipeline
```
[Start] ──> [Pi: Planner] ──> [Pi: Implementer] ──> [Pi: Reviewer] ──> [End]
```

### Pattern D: Parallel Evaluation Fan-out & Join
```
[Start] ──> [Parallel Split] ┬──> [Pi: Security Audit] ─────┬──> [Parallel Join] ──> [End]
                             └──> [Pi: Performance Audit] ──┘
```

---

## 6. Detailed References

- [Camunda 7 Extensions Guide](references/camunda-extensions.md)
- [Modeling Best Practices](references/modeling-best-practices.md)
- [Harness Adapters Reference](references/harness-adapters.md)
- [Opinionated Lint Config](config/bpmnlintrc.json)
- [Custom Camunda Rules Validator](rules/camunda-rules.js)
