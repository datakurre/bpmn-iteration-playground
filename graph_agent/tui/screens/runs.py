"""Runs screen for graph-agent TUI."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

if TYPE_CHECKING:
    from textual.app import ComposeResult
    from textual.binding import BindingType
    from textual.screen import Screen
    from textual.widgets import DataTable
else:
    try:
        from textual.app import ComposeResult
        from textual.screen import Screen
    except ImportError:
        # Fallback dummy classes if textual is not installed
        class Screen:  # type: ignore[no-redef]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def __class_getitem__(cls, item: Any) -> type:
                return cls

        class ComposeResult:  # type: ignore[no-redef]
            pass


class RunsScreen(Screen):  # type: ignore
    """Screen listing all active and past workflow runs."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("enter", "select_run", "Detail"),
        ("d", "select_run", "Detail"),
        ("i", "goto_inbox", "Inbox"),
        ("s", "start_run", "Start"),
        ("e", "open_editor", "Editor"),
        ("l", "goto_logs", "Logs"),
        ("r", "refresh_runs", "Refresh"),
        ("c", "cancel_run", "Cancel"),
        ("m", "merge_run", "Merge"),
        ("q", "quit", "Quit"),
    ]

    def __init__(self, name: str | None = None, id: str | None = None, classes: str | None = None) -> None:
        super().__init__(name=name, id=id, classes=classes)
        self.runs: list[dict[str, Any]] = []

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, Horizontal
            from textual.widgets import Button, DataTable, Footer, Header, Static

            yield Header(show_clock=True)
            with Container(id="runs-container"):
                yield Static("[b]Workflow Runs[/b]  (Enter/d: Detail, i: Inbox, s: Start, e: Editor, r: Refresh, m: Merge, c: Cancel)", id="runs-title")
                yield DataTable(id="runs-table", cursor_type="row")
                with Horizontal(id="runs-actions"):
                    yield Button("View Detail [d]", id="btn-detail", variant="primary")
                    yield Button("Inbox [i]", id="btn-inbox")
                    yield Button("Start New [s]", id="btn-start", variant="success")
                    yield Button("Editor [e]", id="btn-editor")
                    yield Button("Refresh [r]", id="btn-refresh")
                    yield Button("Merge [m]", id="btn-merge")
                    yield Button("Cancel [c]", id="btn-cancel", variant="error")
            yield Footer()
        except ImportError:
            pass

    async def on_mount(self) -> None:
        try:
            table = self.query_one("#runs-table", DataTable)
            table.add_columns("Run ID", "Template / Process", "Status", "Current Task", "Updated", "Merge")
            await self.action_refresh_runs()
            self.set_interval(3.0, self.action_refresh_runs)
        except Exception:
            pass

    async def action_refresh_runs(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            self.runs = await client.list_runs()
            table = self.query_one("#runs-table", DataTable)
            table.clear()
            for r in self.runs:
                wid = r.get("workflow_id") or r.get("id", "")
                pid = r.get("process_id", "workflow")
                status = r.get("status", "unknown")
                cur_task = r.get("current_task") or "-"
                updated = (r.get("updated_at") or r.get("created_at") or "")[:19].replace("T", " ")
                merge = r.get("merge_status") or "-"

                status_styled = status
                if status == "completed":
                    status_styled = f"[green]{status}[/green]"
                elif status in ("failed", "cancelled", "error"):
                    status_styled = f"[red]{status}[/red]"
                elif status in ("waiting_human", "waiting_pi", "running"):
                    status_styled = f"[yellow]{status}[/yellow]"

                merge_styled = merge
                if merge == "merged":
                    merge_styled = f"[green]{merge}[/green]"
                elif merge == "merge_deferred":
                    merge_styled = f"[magenta]{merge}[/magenta]"

                table.add_row(
                    wid[:8],
                    pid,
                    status_styled,
                    cur_task,
                    updated,
                    merge_styled,
                    key=wid,
                )
        except Exception as exc:
            self.notify(f"Failed to refresh runs: {exc}", severity="error")

    def get_selected_run_id(self) -> str | None:
        try:
            table = self.query_one("#runs-table", DataTable)
            if table.cursor_row is not None and table.cursor_row < len(self.runs):
                r = self.runs[table.cursor_row]
                return str(r.get("workflow_id") or r.get("id", ""))
        except Exception:
            pass
        return None

    def action_select_run(self) -> None:
        wid = self.get_selected_run_id()
        if wid:
            from graph_agent.tui.screens.detail import RunDetailScreen

            self.app.push_screen(RunDetailScreen(workflow_id=wid))

    def on_data_table_row_selected(self, event: Any) -> None:
        self.action_select_run()

    def action_goto_inbox(self) -> None:
        from graph_agent.tui.screens.inbox import InboxScreen

        self.app.push_screen(InboxScreen())

    def action_start_run(self) -> None:
        from graph_agent.tui.screens.start import StartScreen

        self.app.push_screen(StartScreen())

    def action_goto_logs(self) -> None:
        from graph_agent.tui.screens.log import LogScreen

        self.app.push_screen(LogScreen())

    async def action_cancel_run(self) -> None:
        wid = self.get_selected_run_id()
        if not wid:
            self.notify("No run selected", severity="warning")
            return
        client = getattr(self.app, "client", None)
        if client:
            try:
                await client.cancel_run(wid)
                self.notify(f"Cancelled run {wid[:8]}", severity="information")
                await self.action_refresh_runs()
            except Exception as exc:
                self.notify(f"Failed to cancel: {exc}", severity="error")

    async def action_merge_run(self) -> None:
        wid = self.get_selected_run_id()
        if not wid:
            self.notify("No run selected", severity="warning")
            return
        client = getattr(self.app, "client", None)
        if client:
            try:
                res = await client.merge_run(wid)
                self.notify(f"Merge status: {res.get('status')} - {res.get('message')}", severity="information")
                await self.action_refresh_runs()
            except Exception as exc:
                self.notify(f"Failed to merge: {exc}", severity="error")

    def action_open_editor(self) -> None:
        import webbrowser

        client = getattr(self.app, "client", None)
        base_url = getattr(client, "base_url", "http://127.0.0.1:8000") if client else "http://127.0.0.1:8000"
        url = f"{base_url}/editor"
        try:
            webbrowser.open(url)
            self.notify(f"Opened BPMN editor at {url}", severity="information")
        except Exception as exc:
            self.notify(f"Failed to open browser: {exc}", severity="error")

    async def on_button_pressed(self, event: Any) -> None:
        btn_id = getattr(event.button, "id", "")
        if btn_id == "btn-detail":
            self.action_select_run()
        elif btn_id == "btn-inbox":
            self.action_goto_inbox()
        elif btn_id == "btn-start":
            self.action_start_run()
        elif btn_id == "btn-editor":
            self.action_open_editor()
        elif btn_id == "btn-refresh":
            await self.action_refresh_runs()
        elif btn_id == "btn-merge":
            await self.action_merge_run()
        elif btn_id == "btn-cancel":
            await self.action_cancel_run()
