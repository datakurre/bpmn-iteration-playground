"""Visual BPMN Stepper / Mini-Map widget for graph execution state."""

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


class BpmnStepper(Static):
    """Renders a visual stepper tracking the BPMN execution phases."""

    DEFAULT_CSS = """
    BpmnStepper {
        height: 3;
        margin-bottom: 1;
        background: $panel;
    }
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.state_data: dict[str, Any] = {}

    def update_state(self, run_state: dict[str, Any]) -> None:
        self.state_data = run_state
        self.refresh()

    def _compute_steps(self) -> list[str]:
        status = self.state_data.get("status", "unknown")
        tasks = self.state_data.get("tasks", [])
        active_names = [t.get("name", "") for t in tasks if t.get("state") in ("READY", "STARTED", "WAITING")]
        done_names = [t.get("name", "") for t in tasks if t.get("state") == "COMPLETED"]

        p1_active = any("Prompt" in n for n in active_names) or (not tasks and status == "running")
        p1_done = any("Prompt" in n for n in done_names)

        p2_active = any("Plan" in n or "Lint" in n for n in active_names)
        p2_done = any("Plan" in n for n in done_names)

        p3_active = any("Apply" in n or "Extend" in n for n in active_names)
        p3_done = any("Apply" in n or "Extend" in n for n in done_names)

        p5_active = any("Review" in n for n in active_names)
        p5_done = any("Review" in n for n in done_names)

        standard_keywords = ("prompt", "plan", "lint", "apply", "extend", "review", "start", "end", "root")
        spliced_tasks = [
            t for t in tasks
            if not any(k in t.get("name", "").lower() or k in t.get("id", "").lower() for k in standard_keywords)
        ]
        spliced_completed = sum(1 for t in spliced_tasks if t.get("state") == "COMPLETED")
        spliced_total = len(spliced_tasks)

        p4_active = any(t.get("state") in ("READY", "STARTED") for t in spliced_tasks) or (p3_done and not p5_active and not p5_done and status == "running")
        p4_done = (spliced_total > 0 and spliced_completed == spliced_total) or (p3_done and (p5_active or p5_done))

        steps: list[str] = []
        steps.append("[bold cyan]▶ 1. Prompt User[/bold cyan]" if p1_active else ("[green]✓ 1. Prompt[/green]" if p1_done else "[dim]1. Prompt[/dim]"))
        steps.append("[bold cyan]⚙ 2. Planner Loop[/bold cyan]" if p2_active else ("[green]✓ 2. Planner[/green]" if p2_done else "[dim]2. Planner[/dim]"))
        steps.append("[bold cyan]⚡ 3. Splicing BPMN[/bold cyan]" if p3_active else ("[green]✓ 3. Migrated[/green]" if p3_done else "[dim]3. Migrate[/dim]"))

        if p4_active:
            cnt_str = f" ({spliced_completed}/{spliced_total})" if spliced_total else ""
            steps.append(f"[bold cyan]▶ 4. Executing{cnt_str}[/bold cyan]")
        elif p4_done:
            steps.append("[green]✓ 4. Executed[/green]")
        else:
            steps.append("[dim]4. Execute[/dim]")

        steps.append("[bold yellow]⏸ 5. Review Checkpoint[/bold yellow]" if p5_active else ("[green]✓ 5. Review[/green]" if p5_done else "[dim]5. Review[/dim]"))
        steps.append("[bold green]★ Complete[/bold green]" if status == "completed" else "[dim]Done[/dim]")
        return steps

    def render(self) -> Any:
        from rich.panel import Panel
        from rich.text import Text

        try:
            steps = self._compute_steps()
            joined = " [dim]─>[/dim] ".join(steps)
            text = Text.from_markup(f"  {joined}")
            return Panel(text, style="blue", height=3)
        except Exception:
            return Text("BPMN Stepper: Initializing...")
