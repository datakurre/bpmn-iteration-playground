"""Command Palette modal screen for quick keyboard navigation."""

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


class CommandPaletteModal(ModalScreen):  # type: ignore
    """Quick action command palette modal overlay."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "dismiss_palette", "Close"),
    ]

    DEFAULT_CSS = """
    CommandPaletteModal {
        align: center middle;
    }

    #palette-container {
        width: 70%;
        height: 60%;
        background: $surface;
        border: solid $accent;
        padding: 1 2;
    }

    #palette-input {
        margin-bottom: 1;
    }

    #palette-options {
        height: 1fr;
    }
    """

    PALETTE_ACTIONS: ClassVar[list[tuple[str, str]]] = [
        ("session_picker", "Session Hub / Resume List (Switch to session picker)"),
        ("new_session", "Start New Session (Launch fresh interactive BPMN loop)"),
        ("open_diff", "View Git Worktree Diff (Inspect file changes)"),
        ("open_editor", "Open BPMN Web Modeler (Open browser editor)"),
        ("goto_inbox", "Workflow Inbox (Pending human tasks & deferred merges)"),
        ("goto_runs", "All Workflow Runs (Detailed technical list)"),
        ("goto_logs", "Daemon Activity Logs (Structured logging tail)"),
    ]

    def __init__(self, current_workflow_id: str | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.current_workflow_id = current_workflow_id

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container
            from textual.widgets import Input, OptionList
            from textual.widgets.option_list import Option

            with Container(id="palette-container"):
                yield Input(placeholder="Type a command or action...", id="palette-input")
                options = [Option(label, id=cmd_id) for cmd_id, label in self.PALETTE_ACTIONS]
                yield OptionList(*options, id="palette-options")
        except ImportError:
            pass

    def on_input_changed(self, event: Any) -> None:
        try:
            from textual.widgets import OptionList
            from textual.widgets.option_list import Option

            query = str(event.value).lower().strip()
            opt_list = self.query_one("#palette-options", OptionList)
            opt_list.clear_options()

            filtered = [
                Option(label, id=cmd_id)
                for cmd_id, label in self.PALETTE_ACTIONS
                if query in label.lower() or query in cmd_id.lower()
            ]
            opt_list.add_options(filtered)
        except Exception:
            pass

    def on_option_list_option_selected(self, event: Any) -> None:
        cmd_id = event.option_id
        self.dismiss()

        if cmd_id == "session_picker":
            from graph_agent.tui.screens.session_picker import SessionPickerScreen

            self.app.push_screen(SessionPickerScreen())
        elif cmd_id == "new_session":
            from graph_agent.tui.screens.session_picker import SessionPickerScreen

            picker = SessionPickerScreen()
            self.app.push_screen(picker)
            if hasattr(self, "run_worker"):
                self.run_worker(picker.action_new_session())
            else:
                import asyncio

                self._bg_task = asyncio.create_task(picker.action_new_session())
        elif cmd_id == "open_diff":
            if self.current_workflow_id:
                from graph_agent.tui.screens.diff_modal import DiffModalScreen

                self.app.push_screen(DiffModalScreen(workflow_id=self.current_workflow_id))
            else:
                self.notify("No active session selected to view diff", severity="warning")
        elif cmd_id == "open_editor":
            import webbrowser

            client = getattr(self.app, "client", None)
            url = f"{client.base_url}/editor" if client else "http://127.0.0.1:8000/editor"
            webbrowser.open(url)
            self.notify(f"Opened {url} in browser", severity="information")
        elif cmd_id == "goto_inbox":
            from graph_agent.tui.screens.inbox import InboxScreen

            self.app.push_screen(InboxScreen())
        elif cmd_id == "goto_runs":
            from graph_agent.tui.screens.runs import RunsScreen

            self.app.push_screen(RunsScreen())
        elif cmd_id == "goto_logs":
            from graph_agent.tui.screens.log import LogScreen

            self.app.push_screen(LogScreen())

    def action_dismiss_palette(self) -> None:
        self.dismiss()
