"""Inbox screen aggregating pending human tasks and deferred merges."""

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


class InboxScreen(Screen):  # type: ignore[misc]
    """Aggregates actionable items across all graphs: human tasks and deferred merges."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("enter", "action_item", "Open/Action"),
        ("escape", "go_back", "Back"),
        ("b", "go_back", "Back"),
        ("r", "refresh_inbox", "Refresh"),
    ]

    def __init__(self, name: str | None = None, id: str | None = None, classes: str | None = None) -> None:
        super().__init__(name=name, id=id, classes=classes)
        self.inbox_items: list[dict[str, Any]] = []

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, Horizontal
            from textual.widgets import Button, DataTable, Footer, Header, Static

            yield Header(show_clock=True)
            with Container(id="inbox-container"):
                yield Static(
                    "[b]Inbox: Action Items Across All Runs[/b]  (Enter: Open Form / Retry Merge, b/Esc: Back, r: Refresh)",
                    id="inbox-title",
                )
                yield DataTable(id="inbox-table", cursor_type="row")
                with Horizontal(id="inbox-actions"):
                    yield Button("Open / Action [Enter]", id="btn-action", variant="primary")
                    yield Button("Back [b/Esc]", id="btn-back")
                    yield Button("Refresh [r]", id="btn-refresh")
            yield Footer()
        except ImportError:
            pass

    async def on_mount(self) -> None:
        try:
            from textual.widgets import DataTable

            table = self.query_one("#inbox-table", DataTable)
            table.add_columns("Type", "Run ID", "Template / Process", "Action Item", "Created")
            await self.action_refresh_inbox()
            self.set_interval(3.0, self.action_refresh_inbox)
        except Exception:
            pass

    async def action_refresh_inbox(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            from textual.widgets import DataTable

            self.inbox_items = await client.get_inbox()
            table = self.query_one("#inbox-table", DataTable)
            table.clear()

            for item in self.inbox_items:
                itype = item.get("type", "")
                wid = item.get("workflow_id", "")
                pid = item.get("process_id", "workflow")
                name = item.get("task_name", "Action")
                created = (item.get("created_at") or "")[:19].replace("T", " ")

                if itype == "human_task":
                    type_label = "[bold yellow]Human Task[/bold yellow]"
                elif itype == "deferred_merge":
                    type_label = "[bold magenta]Deferred Merge[/bold magenta]"
                else:
                    type_label = itype

                table.add_row(type_label, wid[:8], pid, name, created, key=f"{wid}_{item.get('task_id')}")

        except Exception as exc:
            self.notify(f"Failed to refresh inbox: {exc}", severity="error")

    def get_selected_item(self) -> dict[str, Any] | None:
        try:
            from textual.widgets import DataTable

            table = self.query_one("#inbox-table", DataTable)
            if table.cursor_row is not None and table.cursor_row < len(self.inbox_items):
                return dict(self.inbox_items[table.cursor_row])
        except Exception:
            pass
        return None

    async def action_action_item(self) -> None:
        item = self.get_selected_item()
        if not item:
            self.notify("No item selected", severity="warning")
            return

        wid = item.get("workflow_id", "")
        itype = item.get("type", "")

        if itype == "human_task":
            tid = item.get("task_id")
            from graph_agent.tui.screens.form import FormScreen

            self.app.push_screen(FormScreen(workflow_id=wid, task_id=tid))
        elif itype == "deferred_merge":
            client = getattr(self.app, "client", None)
            if client:
                try:
                    res = await client.merge_run(wid)
                    self.notify(f"Merge: {res.get('status')} - {res.get('message')}", severity="information")
                    await self.action_refresh_inbox()
                except Exception as exc:
                    self.notify(f"Merge error: {exc}", severity="error")

    def action_go_back(self) -> None:
        self.app.pop_screen()

    async def on_button_pressed(self, event: Any) -> None:
        btn_id = getattr(event.button, "id", "")
        if btn_id == "btn-action":
            await self.action_action_item()
        elif btn_id == "btn-back":
            self.action_go_back()
        elif btn_id == "btn-refresh":
            await self.action_refresh_inbox()
