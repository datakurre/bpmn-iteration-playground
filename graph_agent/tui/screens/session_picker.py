"""Session Picker / Resume List Screen for graph-agent TUI."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

if TYPE_CHECKING:
    from textual.app import ComposeResult
    from textual.binding import BindingType
    from textual.screen import Screen
else:
    try:
        from textual.app import ComposeResult
        from textual.screen import Screen
    except ImportError:

        class Screen:  # type: ignore[no-redef]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def __class_getitem__(cls, item: Any) -> type:
                return cls

        class ComposeResult:  # type: ignore[no-redef]
            pass


class SessionPickerScreen(Screen):  # type: ignore
    """OpenCode-style startup session picker and resume hub."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("enter", "select_item", "Open / Resume"),
        ("n", "new_session", "New Session"),
        ("d", "view_detail", "Run Detail"),
        ("m", "merge_session", "Merge"),
        ("w", "open_browser", "Web UI (Dev)"),
        ("c", "cancel_session", "Cancel"),
        ("x", "delete_session", "Purge"),
        ("r", "refresh_sessions", "Refresh"),
        ("q", "quit", "Quit"),
    ]

    def __init__(self, name: str | None = None, id: str | None = None, classes: str | None = None) -> None:
        super().__init__(name=name, id=id, classes=classes)
        self.sessions: list[dict[str, Any]] = []

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container
            from textual.widgets import DataTable, Footer, Header, Static

            yield Header(show_clock=True)
            with Container(id="picker-container"):
                yield Static(
                    "[bold cyan]BPMN Agent Session Hub[/bold cyan]  (Enter: Open, n: New, d: Detail, w: Web UI, m: Merge, c: Cancel, x: Purge)",
                    id="picker-title",
                )
                yield DataTable(id="sessions-table", cursor_type="row")
            yield Footer()
        except ImportError:
            pass

    async def on_mount(self) -> None:
        try:
            from textual.widgets import DataTable

            table = self.query_one("#sessions-table", DataTable)
            table.add_columns("Action / Session ID", "Status", "Prompt / Goal Summary", "Branch / Worktree", "Updated")
            await self.action_refresh_sessions()
            self.set_interval(3.0, self.action_refresh_sessions)
        except Exception:
            pass

    async def action_refresh_sessions(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            from textual.widgets import DataTable

            self.sessions = await client.list_runs()
            table = self.query_one("#sessions-table", DataTable)
            table.clear()

            # Row 0: Top-level Start New Session entry
            table.add_row(
                "[bold green]+ Start New Session[/bold green]",
                "[bold green][NEW][/bold green]",
                "Launch a fresh interactive BPMN session",
                "-",
                "-",
                key="__NEW_SESSION__",
            )

            # Sort sessions by updated_at descending
            sorted_sessions = sorted(
                self.sessions,
                key=lambda s: s.get("updated_at") or s.get("created_at") or "",
                reverse=True,
            )

            for s in sorted_sessions:
                wid = str(s.get("workflow_id") or s.get("id") or "")
                status = s.get("status", "unknown")
                pid = s.get("process_id", "workflow")
                updated = (s.get("updated_at") or s.get("created_at") or "")[:19].replace("T", " ")

                # Find goal / prompt summary from workflow data
                data = s.get("data", {})
                goal = (
                    data.get("user_prompt")
                    or data.get("goal")
                    or data.get("feature_request")
                    or data.get("instructions")
                    or s.get("current_task")
                    or pid
                )
                if len(str(goal)) > 50:
                    goal = f"{str(goal)[:47]}..."

                # Format status badge
                if status == "waiting_human":
                    st_styled = "[bold yellow]⏸ WAITING REVIEW[/bold yellow]"
                elif status in ("running", "waiting_pi", "retry_requested"):
                    st_styled = "[bold cyan]▶ RUNNING[/bold cyan]"
                elif status == "completed":
                    st_styled = "[bold green]✓ COMPLETED[/bold green]"
                elif status == "failed":
                    st_styled = "[bold red]✗ FAILED[/bold red]"
                elif status == "cancelled":
                    st_styled = "[dim]⏹ CANCELLED[/dim]"
                else:
                    st_styled = status

                branch = f"bpmn/run/{wid[:8]}"

                table.add_row(
                    f"[bold]{wid[:8]}[/bold]",
                    st_styled,
                    str(goal),
                    branch,
                    updated,
                    key=wid,
                )
        except Exception as exc:
            self.notify(f"Failed to refresh sessions: {exc}", severity="error")

    def get_selected_session_id(self) -> str | None:
        try:
            from textual.widgets import DataTable

            table = self.query_one("#sessions-table", DataTable)
            if table.cursor_row is not None:
                if table.cursor_row == 0:
                    return "__NEW_SESSION__"
                # Row index matches sorted sessions
                actual_idx = table.cursor_row - 1
                if 0 <= actual_idx < len(self.sessions):
                    s = self.sessions[actual_idx]
                    return str(s.get("workflow_id") or s.get("id") or "")
        except Exception:
            pass
        return None

    async def action_new_session(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            # Find interactive_session template
            templates = await client.get_templates()
            tmpl_path = "interactive_session.bpmn"
            for t in templates:
                pid = t.get("process_id") or t.get("id", "")
                if "interactive_session" in pid or "interactive_session" in str(t.get("path", "")):
                    tmpl_path = str(t.get("path") or tmpl_path)
                    break

            started = await client.start_run(tmpl_path, {})
            wid = started.get("workflow_id")
            if wid:
                from graph_agent.tui.screens.session_chat import SessionChatScreen

                self.app.push_screen(SessionChatScreen(workflow_id=wid))
        except Exception as exc:
            self.notify(f"Failed to start new session: {exc}", severity="error")

    def action_select_item(self) -> None:
        sid = self.get_selected_session_id()
        if sid == "__NEW_SESSION__":
            if hasattr(self, "run_worker"):
                self.run_worker(self.action_new_session())
            else:
                import asyncio

                self._bg_task = asyncio.create_task(self.action_new_session())
        elif sid:
            from graph_agent.tui.screens.session_chat import SessionChatScreen

            self.app.push_screen(SessionChatScreen(workflow_id=sid))

    def on_data_table_row_selected(self, event: Any) -> None:
        self.action_select_item()

    def action_view_detail(self) -> None:
        sid = self.get_selected_session_id()
        if sid and sid != "__NEW_SESSION__":
            from graph_agent.tui.screens.detail import RunDetailScreen

            self.app.push_screen(RunDetailScreen(workflow_id=sid))

    async def action_merge_session(self) -> None:
        sid = self.get_selected_session_id()
        if not sid or sid == "__NEW_SESSION__":
            return
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            res = await client.merge_run(sid)
            st = res.get("status")
            if st == "merged":
                self.notify(f"Merged session {sid[:8]}!", severity="information")
            else:
                self.notify(f"Merge result ({st}): {res.get('message', '')}", severity="warning")
            await self.action_refresh_sessions()
        except Exception as exc:
            self.notify(f"Failed to merge session: {exc}", severity="error")

    async def action_cancel_session(self) -> None:
        sid = self.get_selected_session_id()
        if not sid or sid == "__NEW_SESSION__":
            return
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            res = await client.cancel_run(sid)
            self.notify(f"Cancelled session {sid[:8]} (status: {res.get('status')})", severity="information")
            await self.action_refresh_sessions()
        except Exception as exc:
            self.notify(f"Failed to cancel session: {exc}", severity="error")

    async def action_delete_session(self) -> None:
        sid = self.get_selected_session_id()
        if not sid or sid == "__NEW_SESSION__":
            return
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            await client.delete_run(sid)
            self.notify(f"Purged session {sid[:8]}", severity="information")
            await self.action_refresh_sessions()
        except Exception as exc:
            self.notify(f"Failed to purge session: {exc}", severity="error")

    def action_open_browser(self) -> None:
        import os
        import webbrowser

        client = getattr(self.app, "client", None)
        base_url = getattr(client, "base_url", None) or "http://127.0.0.1:8080"
        token = getattr(client, "token", None) or os.environ.get("ADMIN_TOKEN")
        query = "?dev=1" + (f"&token={token}" if token else "")

        sid = self.get_selected_session_id()
        url = (
            f"{base_url}/instance/{sid}{query}"
            if sid and sid != "__NEW_SESSION__"
            else f"{base_url}/{query}"
        )
        try:
            webbrowser.open(url)
            self.notify(f"Opened Web Studio in browser ({url})", severity="information")
        except Exception as exc:
            self.notify(f"Failed to open browser: {exc}", severity="error")

    async def on_button_pressed(self, event: Any) -> None:
        btn_id = getattr(event.button, "id", "")
        if btn_id == "btn-new":
            await self.action_new_session()
        elif btn_id == "btn-resume":
            self.action_select_item()
        elif btn_id == "btn-detail":
            self.action_view_detail()
        elif btn_id == "btn-merge":
            await self.action_merge_session()
        elif btn_id == "btn-refresh":
            await self.action_refresh_sessions()
        elif btn_id == "btn-quit":
            self.app.exit()
