# Extending Adapters

The engine dispatches AI and tool tasks through pluggable adapters registered in `AdapterRegistry`.

## Implementing `BaseAdapter`

Create a subclass of `BaseAdapter` in `app/adapters/`:

```python
from app.adapters.base import BaseAdapter, AgentResult


class ClaudeCodeAdapter(BaseAdapter):
    @property
    def adapter_type(self) -> str:
        return "claude_code"

    async def run(
        self,
        prompt: str,
        config: dict[str, str],
        cwd: str,
    ) -> AgentResult:
        # Custom execution logic, subprocess call, or LLM API invocation
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

## Registering the Adapter

Register your adapter in `AdapterRegistry`:

```python
from app.adapters.registry import AdapterRegistry

registry = AdapterRegistry()
registry.register(ClaudeCodeAdapter())

service = WorkflowService(store, adapter_registry=registry)
```

In your BPMN diagram, set the task property:
```xml
<camunda:property name="harness_type" value="claude_code" />
```
