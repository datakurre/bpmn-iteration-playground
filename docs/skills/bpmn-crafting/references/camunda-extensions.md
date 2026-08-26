# Camunda 7 Extensions in graph-agent

This document is the authoritative reference on how Camunda 7 (Operaton) extension elements are interpreted by the `graph-agent` execution engine (backed by SpiffWorkflow and adapter harnesses).

---

## 1. Extension Elements Overview

In `graph-agent`, all node behaviors, agent roles, input/output data scoping, and form schemas are defined via standard `xmlns:camunda="http://camunda.org/schema/1.0/bpmn"` tags inside `<bpmn:extensionElements>`.

The engine reads three primary extension structures:
1. `<camunda:properties>` — Static harness configuration and metadata
2. `<camunda:inputOutput>` — Pure data scoping into and out of tasks/subprocesses
3. `<camunda:formData>` — Human user task form field definitions (rendered via FormJS)

---

## 2. `<camunda:properties>`

Used to declare runtime harness execution settings. These values are read directly by the orchestrator and adapters.

```xml
<bpmn:serviceTask id="Task_Implement" name="Implement Feature">
  <bpmn:extensionElements>
    <camunda:properties>
      <camunda:property name="harness_type" value="pi_agent" />
      <camunda:property name="agent_role" value="implementer" />
      <camunda:property name="timeout" value="1800" />
    </camunda:properties>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

### Supported Properties by Harness

| Property | Applies To | Description | Example |
| :--- | :--- | :--- | :--- |
| `harness_type` | All ServiceTasks | **Required.** Registered adapter name: `pi_agent`, `shell`, `sandbox_pi`, `sandbox_shell`, `mock_agent`. | `pi_agent` |
| `agent_role` | `pi_agent`, `sandbox_pi` | Prompt / role specialization: `implementer`, `planner`, `reviewer`, `assistant`, `researcher`. | `implementer` |
| `command` | `shell`, `sandbox_shell` | Command line executed in workspace. Split with `shlex` unless `shell="true"`. | `pytest -q` |
| `template` | `shell`, `sandbox_shell` | Unpacks a template into workspace before command. | `beamer` |
| `fail_on_error` | `shell`, `sandbox_shell` | `"true"` (default) fails task on non-zero exit; `"false"` publishes `status = 'failed'` for branching. | `false` |
| `workdir` | `shell`, `sandbox_shell` | Subdirectory inside the instance workspace to execute within. | `src/` |
| `timeout` | All harnesses | Execution timeout in seconds (default: 1800s for Pi, 900s for Shell). | `900` |
| `artifacts` | `shell`, `pi_agent` | Glob pattern(s) for files to collect after turn completion. | `dist/*.pdf` |

---

## 3. `<camunda:inputOutput>` & Data Scoping

Data scoping is **explicit** in `graph-agent`. Service tasks and CallActivities only see variables declared in `<camunda:inputParameter>`, and only publish variables declared in `<camunda:outputParameter>`.

```xml
<camunda:inputOutput>
  <!-- Input parameters: map workflow data into task scope/prompt -->
  <camunda:inputParameter name="topic">${brief.topic}</camunda:inputParameter>
  <camunda:inputParameter name="guidelines">${guidelines}</camunda:inputParameter>
  <camunda:inputParameter name="header">Review for ${author}</camunda:inputParameter>

  <!-- Output parameters: map task execution results to workflow variables -->
  <camunda:outputParameter name="review_status">${status}</camunda:outputParameter>
  <camunda:outputParameter name="review_summary">${summary}</camunda:outputParameter>
  <camunda:outputParameter name="review_findings">${findings}</camunda:outputParameter>
</camunda:inputOutput>
```

### Expression Resolution Rules (`resolve_input`)

- **`${var_name}`** — Whole-string match. Preserves native type (`int`, `dict`, `list`, `bool`).
- **`${parent.child.0.key}`** — Dotted path traversal across dicts and list indices.
- **`Prefix ${var} suffix`** — Mixed string interpolation. Stringifies values; missing keys resolve to `""`.
- **Literal** — Value with no `${...}` passes through unchanged.

> [!IMPORTANT]
> `resolve_input` is deliberately NOT an evaluation engine (`no eval`, `no scripts`). It performs safe dictionary lookups only.

### Special Output Source Keys

When an agent turn completes, the adapter publishes these result keys:
- `status` (`${status}`) — Reported status (`success`, `failed`, `needs_review`)
- `summary` (`${summary}`) — Multi-line summary of work done
- `findings` (`${findings}`) — List of findings or inspection items
- `artifacts` (`${artifacts}`) — List of file paths generated or modified
- `next_action` (`${next_action}`) — Suggested next action
- `log` (`${log}`) — Shell harness stdout/stderr log (ShellAdapter only)
- `agent_status` — Raw engine status (`success`, `failed`, `timeout`, `cancelled`)

---

## 4. `<camunda:formData>` & FormJS Human Tasks

Human gates (`<bpmn:userTask>`) define interactive forms rendered by FormJS in the Workflow Studio UI:

```xml
<bpmn:userTask id="Task_Signoff" name="Review Plan">
  <bpmn:extensionElements>
    <camunda:formData>
      <camunda:formField id="plan_preview" label="### Implementation Plan&#10;Please review the generated plan." type="markdown" />
      <camunda:formField id="decision" label="Review Decision" type="enum" defaultValue="accepted">
        <camunda:value id="accepted" name="Accept and Proceed" />
        <camunda:value id="rejected" name="Request Changes" />
      </camunda:formField>
      <camunda:formField id="notes" label="Reviewer Notes" type="textarea" />
    </camunda:formData>
  </bpmn:extensionElements>
</bpmn:userTask>
```

### Supported Form Field Types

| Camunda Type | FormJS Component | Description |
| :--- | :--- | :--- |
| `string`, `text` | `textfield` | Single-line text input |
| `textarea` | `textarea` | Multi-line text area |
| `markdown` | `markdown` | Read-only markdown display in the form header |
| `enum` | `select` | Dropdown select menu with `<camunda:value>` choices |
| `boolean` | `checkbox` | Checkbox toggle (true/false) |
| `long`, `double` | `number` | Numeric input |
| `date` | `datetime` | Date / calendar picker |

---

## 5. `<bpmn:callActivity>` Subprocess Scoping

Reusable sub-workflows (`CallActivity`) are scoped via `<camunda:inputOutput>` on the call activity element itself:

```xml
<bpmn:callActivity id="Call_Review" name="Run Review Cycle" calledElement="agent_review_cycle">
  <bpmn:extensionElements>
    <camunda:inputOutput>
      <camunda:inputParameter name="subject">${document_text}</camunda:inputParameter>
      <camunda:inputParameter name="review_guidance">${review_guidance}</camunda:inputParameter>
      <camunda:outputParameter name="final_decision">${cycle_decision}</camunda:outputParameter>
    </camunda:inputOutput>
  </bpmn:extensionElements>
</bpmn:callActivity>
```
