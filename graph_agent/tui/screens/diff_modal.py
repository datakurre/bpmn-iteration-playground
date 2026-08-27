"""Modal screen for inspecting worktree git diffs."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

if TYPE_CHECKING:
    from textual.app import ComposeResult
    from textual.binding import BindingType
    from textual.screen import ModalScreen
else:
    try:
        from textual.app import ComposeResult
        from textual.screen import ModalScreen
    except ImportError:

        class ModalScreen:  # type: ignore[no-redef]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def __class_getitem__(cls, item: Any) -> type:
                return cls

        class ComposeResult:  # type: ignore[no-redef]
            pass


class DiffModalScreen(ModalScreen):  # type: ignore
    """Modal overlay displaying unified diff for the session worktree."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "dismiss_modal", "Close"),
        ("d", "dismiss_modal", "Close"),
        ("q", "dismiss_modal", "Close"),
    ]

    DEFAULT_CSS = """
    DiffModalScreen {
        align: center middle;
    }

    #diff-modal-container {
        width: 90%;
        height: 85%;
        background: $surface;
        border: solid $accent;
        padding: 1 2;
    }

    #diff-modal-header {
        height: 2;
        color: $accent;
    }

    #diff-modal-actions {
        height: 3;
        dock: bottom;
        align: right middle;
    }
    """

    def __init__(self, workflow_id: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.workflow_id = workflow_id
        self.diff_data: dict[str, Any] = {}

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, Horizontal
            from textual.widgets import Button, Static

            from graph_agent.tui.widgets.diff_view import DiffViewWidget

            with Container(id="diff-modal-container"):
                yield Static(
                    f"[bold cyan]Git Worktree Diff · {self.workflow_id[:8]}[/bold cyan]", id="diff-modal-header"
                )
                yield DiffViewWidget(id="diff-view-widget")
                with Horizontal(id="diff-modal-actions"):
                    yield Button("Close [Esc/d]", id="btn-close", variant="primary")
        except ImportError:
            pass

    async def on_mount(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            from graph_agent.tui.widgets.diff_view import DiffViewWidget

            self.diff_data = await client.get_diff(self.workflow_id)
            diff_text = self.diff_data.get("diff", "")
            widget = self.query_one("#diff-view-widget", DiffViewWidget)
            widget.set_diff(diff_text)
        except Exception as exc:
            self.notify(f"Failed to load diff: {exc}", severity="error")

    def action_dismiss_modal(self) -> None:
        self.dismiss()

    def on_button_pressed(self, event: Any) -> None:
        if getattr(event.button, "id", "") == "btn-close":
            self.dismiss()
