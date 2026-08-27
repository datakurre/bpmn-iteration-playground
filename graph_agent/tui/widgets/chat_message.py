"""Chat message cards and execution bubbles for the Conversational REPL."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from textual.widgets import Static
else:
    try:
        from textual.widgets import Static
    except ImportError:
        class Static:  # type: ignore[no-redef]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass


class UserPromptBubble(Static):
    """User input chat bubble aligned to right."""

    DEFAULT_CSS = """
    UserPromptBubble {
        width: 100%;
        background: $primary-darken-2;
        color: $text;
        border: round $primary;
        padding: 1 2;
        margin: 1 0;
    }
    """

    def __init__(self, prompt_text: str, timestamp: str = "", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.prompt_text = prompt_text
        self.timestamp = timestamp

    def render(self) -> Any:
        from rich.text import Text

        header = f"[bold cyan]You[/bold cyan] [dim]({self.timestamp})[/dim]\n" if self.timestamp else "[bold cyan]You[/bold cyan]\n"
        return Text.from_markup(f"{header}[white]{self.prompt_text}[/white]")


class PlannerMessageCard(Static):
    """Card displaying formulated plan and generated BPMN graph nodes."""

    DEFAULT_CSS = """
    PlannerMessageCard {
        width: 100%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
        margin: 1 0;
    }
    """

    def __init__(self, summary: str, extension_spec: dict[str, Any] | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.summary = summary
        self.extension_spec = extension_spec or {}

    def render(self) -> Any:
        from rich.text import Text

        lines = ["[bold green]⚡ BPMN Planner & Lint Verification[/bold green]\n", f"[white]{self.summary}[/white]"]
        nodes = self.extension_spec.get("nodes", [])
        if nodes:
            lines.append("\n[bold cyan]Planned BPMN Graph Pipeline:[/bold cyan]")
            for i, n in enumerate(nodes, 1):
                name = n.get("name") or n.get("bpmn_id")
                props = n.get("properties", {})
                harness = props.get("harness_type", "pi_agent")
                role = props.get("agent_role", "coder")
                lines.append(f"  [cyan]{i}. {name}[/cyan] [dim]({harness} · {role})[/dim]")
        return Text.from_markup("\n".join(lines))


class TaskExecutionCard(Static):
    """Card displaying turn execution progress, logs, and artifacts."""

    DEFAULT_CSS = """
    TaskExecutionCard {
        width: 100%;
        background: $surface;
        border: solid $secondary;
        padding: 1 2;
        margin: 1 0;
    }
    """

    def __init__(self, task_name: str, status: str, summary: str = "", details: str = "", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.task_name = task_name
        self.status = status
        self.summary = summary
        self.details = details

    def render(self) -> Any:
        from rich.text import Text

        badge = "[green]✓ COMPLETED[/green]" if self.status == "completed" else ("[red]✗ FAILED[/red]" if self.status == "failed" else "[yellow]▶ RUNNING[/yellow]")
        lines = [f"[bold]{self.task_name}[/bold]  {badge}"]
        if self.summary:
            lines.append(f"[dim]{self.summary}[/dim]")
        if self.details:
            lines.append(f"[italic]{self.details}[/italic]")
        return Text.from_markup("\n".join(lines))


class ReviewCheckpointCard(Static):
    """Card presenting human review checkpoint with diff summary."""

    DEFAULT_CSS = """
    ReviewCheckpointCard {
        width: 100%;
        background: $warning-darken-3;
        border: double $warning;
        padding: 1 2;
        margin: 1 0;
    }
    """

    def __init__(self, diff_stat: str = "", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.diff_stat = diff_stat

    def render(self) -> Any:
        from rich.text import Text

        lines = [
            "[bold yellow]⏸ Human Review Checkpoint[/bold yellow]",
            "All planned graph execution turns completed. Please review repository changes.",
        ]
        if self.diff_stat:
            lines.append(f"\n[bold]Git Status / Changed Files:[/bold]\n[dim]{self.diff_stat}[/dim]")
        lines.append("\n[bold green]Type 'approve' to merge & finish[/bold green], or enter revisions below.")
        return Text.from_markup("\n".join(lines))
