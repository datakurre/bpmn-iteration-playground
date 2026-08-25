# Extending Adapters

> This is the worked-example, narrative version. AGENTS.md §4 ("Adapter Capabilities") and
> §8 ("Adding a New Adapter") are the terser, more current reference — check there first if
> something here looks out of date, since AGENTS.md is what changes first.

The engine dispatches AI and tool tasks through pluggable adapters registered in `AdapterRegistry`.

## Implementing `BaseAdapter`

Create a subclass of `BaseAdapter` in `bpmn_agent/adapters/`. `run()`'s signature must include
`on_event` — the orchestrator always calls it as a keyword argument
(`adapter.run(prompt, config, cwd, on_event=...)`) so it can stream live turn events to the
UI, and a `run()` that omits the parameter raises `TypeError` on the very first real turn:

```python
from typing import Any
from bpmn_agent.adapters.base import AdapterCapabilities, BaseAdapter, AgentResult


class ClaudeCodeAdapter(BaseAdapter):
    @property
    def adapter_type(self) -> str:
        return "claude_code"

    @property
    def capabilities(self) -> AdapterCapabilities:
        # Optional -- the default is a conservative "no session, agent view" declaration.
        # Override it if your harness carries conversational state across turns (see
        # "Declaring capabilities" below) or needs a different timeout/UI.
        return AdapterCapabilities(display_name="Claude Code", supports_sessions=True)

    async def run(
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
        on_event: Any = None,
    ) -> AgentResult:
        # Custom execution logic, subprocess call, or LLM API invocation.
        # Call on_event(parsed_event) as events arrive if your harness streams; the
        # orchestrator forwards it to the instance's WebSocket. Fine to ignore if it doesn't.
        # ...
        return AgentResult(
            status="success",
            output={
                "status": "success",
                "summary": "Completed analysis",
                "findings": ["finding 1", "finding 2"],
                "artifacts": ["output.md"],
                "next_action": "continue",
            },
            text="Completed analysis",
            messages=[],
            stderr="",
            exit_code=0,
        )
```

## Declaring capabilities

`AdapterCapabilities` (`bpmn_agent/adapters/base.py`) is how a harness tells the orchestrator what
it is, instead of the orchestrator special-casing `harness_type` strings. The field worth
understanding before you skip it: `supports_sessions` — true for harnesses that carry
conversational state across turns (LLM agents), false for anything deterministic. A harness
that doesn't declare it correctly either loses context it should have kept, or a
deterministic step ends up holding a stale session id and colliding with a real agent turn
running the same session. `GET /api/harnesses` shows what every registered adapter declares.

## Registering the Adapter

Register your adapter in `AdapterRegistry`:

```python
from bpmn_agent.adapters.registry import AdapterRegistry

registry = AdapterRegistry()
registry.register(ClaudeCodeAdapter())

service = WorkflowService(store, adapter_registry=registry)
```

In your BPMN diagram, set the task property:
```xml
<camunda:property name="harness_type" value="claude_code" />
```

## Worked example: the shell harness

`ShellAdapter` (`bpmn_agent/adapters/shell_adapter.py`, `harness_type: shell`) is the built-in
example of an adapter that is not an agent at all. It ignores `prompt` entirely — the task
is defined by its BPMN properties — which is what makes a compiler, slicer, or CAM step a
BPMN node like any other.

```xml
<bpmn:serviceTask id="Task_Build" name="Build PDF">
  <bpmn:extensionElements>
    <camunda:properties>
      <camunda:property name="harness_type" value="shell" />
      <camunda:property name="command" value="make pdf" />
      <camunda:property name="artifacts" value="slides.pdf" />
      <camunda:property name="timeout" value="1800" />
      <camunda:property name="fail_on_error" value="false" />
    </camunda:properties>
    <camunda:inputOutput>
      <camunda:outputParameter name="build_status">${status}</camunda:outputParameter>
      <camunda:outputParameter name="build_log">${log}</camunda:outputParameter>
    </camunda:inputOutput>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

### Properties

| Property | Meaning |
| --- | --- |
| `command` | The command line. Required unless `template` is set. Split with `shlex`; no shell is involved. |
| `shell` | `true` to run `command` through `/bin/sh -c` (pipes, redirection). |
| `workdir` | Subdirectory of the workspace to run in. Must stay inside it. |
| `template` | Directory under `bpmn_agent/data/workspace_templates/` copied in before the run, existing files untouched. |
| `timeout` | Seconds before the command is killed (default 900). |
| `artifacts` | Globs (JSON array or comma-separated) collected afterwards and published as `${artifacts}`. |
| `fail_on_error` | `true` (default) fails the turn on non-zero exit; `false` routes it as data instead. |
| `env` | JSON object of extra environment variables. |
| `log_tail` | Maximum characters of output kept in the result (default 8000). |

### Two things worth copying

**The command never comes from workflow data.** Only from the diagram. Workflow data is
largely agent-written, and `resolve_input()` deliberately refuses to evaluate it as code;
an argv is no different.

**Failure can be data instead of a halt.** By default a non-zero exit fails the turn, and
the instance parks for a human `Retry` — right for a step that is simply broken. With
`fail_on_error="false"` the turn succeeds while the published `${status}` is `failed`, so an
exclusive gateway can branch on it:

```xml
<bpmn:sequenceFlow id="Flow_Build_Failed" sourceRef="GW_Build" targetRef="Task_Diagnose">
  <bpmn:conditionExpression>build_status != 'success'</bpmn:conditionExpression>
</bpmn:sequenceFlow>
```

That flow is what puts a compiler inside the agent loop. In `bpmn_agent/data/workflows/beamer_slides.bpmn`
it leads to a human diagnosis gate carrying `${build_log}`, from which you either hand the
log back to the slide-writing agent or abandon the deck. Routing through a person rather
than straight back to the agent is deliberate: the expression language is not a scripting
language, so there is no loop counter to branch on, and an automatic repair loop against a
compiler the agent cannot satisfy would never terminate.

### Workspace templates

`template="beamer"` copies `bpmn_agent/data/workspace_templates/beamer/` into the instance workspace through
the `prepare_workspace` hook. Files already present are never overwritten, so the scaffold
can re-run on later turns without discarding the agent's edits. A task that declares only
`template` and no `command` is a pure scaffold step.
