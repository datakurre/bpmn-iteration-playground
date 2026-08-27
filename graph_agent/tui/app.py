"""Main Textual application for graph-agent."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, Any, ClassVar

from graph_agent.agents_root import Workspace
from graph_agent.tui.client import DaemonClient

if TYPE_CHECKING:
    from textual.app import App
    from textual.binding import BindingType
else:
    try:
        from textual.app import App
    except ImportError:
        class App:  # type: ignore[no-redef]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def __class_getitem__(cls, item: Any) -> type:
                return cls


TUI_CSS = """
Screen {
    background: $surface;
    color: $text;
}

#runs-container, #inbox-container, #detail-container, #form-container, #start-container, #log-container {
    padding: 1 2;
    height: 100%;
}

#runs-title, #inbox-title, #detail-header, #form-header, #start-header, #log-header {
    margin-bottom: 1;
    color: $accent;
}

#runs-table, #inbox-table, #detail-tasks-table, #detail-savepoints-table {
    height: 1fr;
    border: solid $accent;
    margin-bottom: 1;
}

#runs-actions, #inbox-actions, #detail-actions, #form-actions, #start-actions, #log-actions {
    height: 3;
    dock: bottom;
    align: center middle;
}

#runs-actions Button, #inbox-actions Button, #detail-actions Button, #form-actions Button, #start-actions Button, #log-actions Button {
    margin-right: 2;
}

#detail-meta {
    height: 3;
    margin-bottom: 1;
    background: $panel;
    padding: 0 1;
}

.form-field-block {
    margin-bottom: 1;
}

#tail-rich-log {
    height: 1fr;
    border: solid $accent;
    background: $surface-darken-1;
}
"""


class GraphAgentApp(App):  # type: ignore
    """Textual TUI for graph-agent orchestration platform."""

    CSS = TUI_CSS
    TITLE = "bpmn"
    SUB_TITLE = "Durable Agent Sessions · SpiffWorkflow"

    BINDINGS: ClassVar[list[BindingType]] = [
        ("1", "goto_sessions", "Sessions"),
        ("2", "goto_inbox", "Inbox"),
        ("3", "goto_runs", "Runs"),
        ("4", "goto_logs", "Logs"),
        ("ctrl+p", "open_palette", "Commands"),
        ("ctrl+n", "new_session", "New Session"),
        ("q", "quit", "Quit"),
    ]

    def __init__(
        self,
        client: DaemonClient,
        workspace: Workspace | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.client = client
        self.workspace = workspace

    def on_mount(self) -> None:
        from graph_agent.tui.screens.session_picker import SessionPickerScreen

        self.install_screen(SessionPickerScreen(), name="sessions")
        self.push_screen("sessions")

    def action_goto_sessions(self) -> None:
        from graph_agent.tui.screens.session_picker import SessionPickerScreen

        self.install_screen(SessionPickerScreen(), name="sessions")
        self.switch_screen("sessions")

    def action_new_session(self) -> None:
        from graph_agent.tui.screens.session_picker import SessionPickerScreen

        picker = SessionPickerScreen()
        self.install_screen(picker, name="sessions")
        self.switch_screen("sessions")
        self.run_worker(picker.action_new_session())

    def action_open_palette(self) -> None:
        from graph_agent.tui.screens.command_palette import CommandPaletteModal

        self.push_screen(CommandPaletteModal())

    def action_goto_runs(self) -> None:
        from graph_agent.tui.screens.runs import RunsScreen

        # Install fresh instance so the screen is re-mounted and data is refreshed.
        self.install_screen(RunsScreen(), name="runs")
        self.switch_screen("runs")

    def action_goto_inbox(self) -> None:
        from graph_agent.tui.screens.inbox import InboxScreen

        self.install_screen(InboxScreen(), name="inbox")
        self.switch_screen("inbox")

    def action_goto_start(self) -> None:
        from graph_agent.tui.screens.start import StartScreen

        self.install_screen(StartScreen(), name="start")
        self.switch_screen("start")

    def action_goto_logs(self) -> None:
        from graph_agent.tui.screens.log import LogScreen

        self.install_screen(LogScreen(), name="logs")
        self.switch_screen("logs")


def _patch_data_table() -> None:
    """Patch Textual DataTable._on_click to safely handle out-of-bounds header/row clicks."""
    try:
        import contextlib

        from textual.widgets import DataTable
        original_on_click = DataTable._on_click

        async def _safe_on_click(self: DataTable[Any], event: Any) -> None:
            with contextlib.suppress(IndexError):
                # Textual's _on_click can attempt to index ordered_columns[column_index]
                # when clicking out-of-bounds header areas with cursor_type="row".
                await original_on_click(self, event)

        DataTable._on_click = _safe_on_click  # type: ignore[method-assign]
    except (ImportError, AttributeError):
        pass


_patch_data_table()



def launch_tui(client: DaemonClient, workspace: Workspace | None = None) -> int:
    """Launch Textual TUI with error handling for environments lacking textual."""
    try:
        import textual  # noqa: F401
    except ImportError:
        print(
            "Error: 'textual' package is required to run the graph-agent TUI.\n"
            "Install it via 'pip install textual' or run headless using 'graph-agent serve --no-tui'.",
            file=sys.stderr,
        )
        return 1

    _patch_data_table()
    app = GraphAgentApp(client=client, workspace=workspace)
    app.run()
    return 0

