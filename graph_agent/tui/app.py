"""Main Textual application for graph-agent."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, Any, ClassVar

from graph_agent.agents_root import Workspace
from graph_agent.tui.client import DaemonClient

if TYPE_CHECKING:
    from textual.app import App
else:
    try:
        from textual.app import App
    except ImportError:
        class App:  # type: ignore[no-redef]
            pass


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


class GraphAgentApp(App):  # type: ignore[misc]
    """Textual TUI for graph-agent orchestration platform."""

    CSS = TUI_CSS
    TITLE = "graph-agent"
    SUB_TITLE = "BPMN Agent Orchestration"

    BINDINGS: ClassVar[list[tuple[str, str, str]]] = [
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

    def push_screen(self, screen: Any, **kwargs: Any) -> Any:
        if isinstance(screen, str):
            if screen == "runs":
                from graph_agent.tui.screens.runs import RunsScreen
                return super().push_screen(RunsScreen())
            elif screen == "inbox":
                from graph_agent.tui.screens.inbox import InboxScreen
                return super().push_screen(InboxScreen())
            elif screen == "start":
                from graph_agent.tui.screens.start import StartScreen
                return super().push_screen(StartScreen())
            elif screen == "log":
                from graph_agent.tui.screens.log import LogScreen
                return super().push_screen(LogScreen())
            elif screen == "detail":
                from graph_agent.tui.screens.detail import RunDetailScreen
                wid = kwargs.get("wid", "")
                return super().push_screen(RunDetailScreen(workflow_id=wid))
            elif screen == "form":
                from graph_agent.tui.screens.form import FormScreen
                wid = kwargs.get("workflow_id", "")
                tid = kwargs.get("task_id")
                return super().push_screen(FormScreen(workflow_id=wid, task_id=tid))
        return super().push_screen(screen)


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
