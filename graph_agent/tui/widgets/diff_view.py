"""Colorized unified diff viewer widget for worktree changes."""

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


class DiffViewWidget(Static):
    """Renders git unified diff with syntax highlighting."""

    DEFAULT_CSS = """
    DiffViewWidget {
        height: 1fr;
        border: solid $accent;
        background: $surface-darken-1;
        overflow-y: scroll;
    }
    """

    def __init__(self, diff_text: str = "", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.diff_text = diff_text

    def set_diff(self, diff_text: str) -> None:
        self.diff_text = diff_text
        self.refresh()

    def render(self) -> Any:
        from rich.panel import Panel
        from rich.syntax import Syntax

        if not self.diff_text.strip():
            return Panel("[dim]No uncommitted changes in session worktree.[/dim]", title="Worktree Diff")
        return Syntax(self.diff_text, "diff", theme="monokai", line_numbers=True)
