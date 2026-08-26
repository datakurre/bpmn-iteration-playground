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
    TITLE = "graph-agent"
    SUB_TITLE = "BPMN Agent Orchestration"

    BINDINGS: ClassVar[list[BindingType]] = [
        ("1", "goto_runs", "Runs"),
        ("2", "goto_inbox", "Inbox"),
        ("3", "goto_start", "Start"),
        ("4", "goto_logs", "Logs"),
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
        from graph_agent.tui.screens.runs import RunsScreen

        self.push_screen(RunsScreen())

    def action_goto_runs(self) -> None:
        from graph_agent.tui.screens.runs import RunsScreen

        self.push_screen(RunsScreen())

    def action_goto_inbox(self) -> None:
        from graph_agent.tui.screens.inbox import InboxScreen

        self.push_screen(InboxScreen())

    def action_goto_start(self) -> None:
        from graph_agent.tui.screens.start import StartScreen

        self.push_screen(StartScreen())

    def action_goto_logs(self) -> None:
        from graph_agent.tui.screens.log import LogScreen

        self.push_screen(LogScreen())


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

    app = GraphAgentApp(client=client, workspace=workspace)
    app.run()
    return 0
