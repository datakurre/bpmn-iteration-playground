# Harness Adapters Reference

The `graph-agent` runtime uses an adapter registry to decouple workflow orchestration from task execution. This document details each adapter, its properties, inputs, and output contracts.

---

## 1. `pi_agent` (Pi Coding Agent Bare Subprocess)

Executes a turn of the local Pi CLI coding agent via non-interactive JSON print mode (`--mode json -p <prompt>`).

### Extension Properties (`camunda:properties`)
- `harness_type`: `"pi_agent"` (Required)
- `agent_role`: `"implementer"` | `"planner"` | `"reviewer"` | `"assistant"` | `"researcher"` (Recommended)
- `timeout`: Timeout in seconds (default: `1800`)

### Output Contract (JSON)
On completion, Pi emits a 5-key JSON payload:
```json
{
  "status": "success",
  "summary": "Implemented feature and added unit tests",
  "findings": ["Found 1 edge case in parser"],
  "artifacts": ["src/parser.ts", "tests/parser.test.ts"],
  "next_action": "Run test suite"
}
```

---

## 2. `sandbox_pi` (Podman-Isolated Pi Agent)

Executes Pi inside `agent-sandbox` with enforced network egress and secrets isolation policies.

### Extension Properties (`camunda:properties`)
- `harness_type`: `"sandbox_pi"`
- `agent_role`: Role variant
- `timeout`: Timeout in seconds

---

## 3. `shell` (Deterministic Shell Step)

Executes a deterministic non-LLM command (e.g. `pytest`, `cargo build`, `pdflatex`, slicer, CAM) in the instance workspace.

### Extension Properties (`camunda:properties`)
- `harness_type`: `"shell"` (Required)
- `command`: Command line string (Required, unless `template` is set)
- `template`: Workspace template name to unpack into workspace (Optional)
- `shell`: `"true"` to run command through `/bin/sh -c` (for pipes/redirection)
- `workdir`: Subdirectory of workspace to run command in
- `fail_on_error`: `"true"` (default) fails task immediately; `"false"` sets `status = 'failed'` for branch routing
- `timeout`: Timeout in seconds (default: `900`)
- `artifacts`: Glob pattern or JSON list of artifacts to collect

### Output Contract
- `status`: `"success"` if exit code is 0; `"failed"` if non-zero
- `summary`: One-line summary including command and exit code
- `log`: Captured stdout and stderr output
- `artifacts`: Collected artifact paths matching declared patterns

---

## 4. `mock_agent` (Deterministic In-Process Stub)

Used in testing and demonstrations. Returns mock success payload without requiring external models or credentials.

### Extension Properties (`camunda:properties`)
- `harness_type`: `"mock_agent"`
