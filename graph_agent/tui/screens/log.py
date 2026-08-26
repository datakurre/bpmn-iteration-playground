"""Log viewer screen tailing daemon/workspace logs."""

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


class LogScreen(Screen):  # type: ignore
    """Tails daemon and execution logs from the workspace."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "go_back", "Back"),
        ("b", "go_back", "Back"),
        ("r", "refresh_logs", "Refresh"),
    ]

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, Horizontal
            from textual.widgets import Button, Footer, Header, RichLog, Static

            yield Header(show_clock=True)
            with Container(id="log-container"):
                yield Static("[b]Workspace Daemon & Activity Logs[/b]  (Auto-tailing)", id="log-header")
                yield RichLog(id="tail-rich-log", highlight=True, markup=True)
                with Horizontal(id="log-actions"):
                    yield Button("Back [b/Esc]", id="btn-back")
                    yield Button("Refresh [r]", id="btn-refresh")
            yield Footer()
        except ImportError:
            pass

    async def on_mount(self) -> None:
        await self.action_refresh_logs()
        self.set_interval(2.0, self.action_refresh_logs)

    async def action_refresh_logs(self) -> None:
        import asyncio

        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            from textual.widgets import RichLog

            logs_text = await asyncio.to_thread(client.tail_logs, 200)
            log_widget = self.query_one("#tail-rich-log", RichLog)
            log_widget.clear()
            log_widget.write(logs_text)
        except Exception:
            pass

    def action_go_back(self) -> None:
        self.app.pop_screen()

    async def on_button_pressed(self, event: Any) -> None:
        btn_id = getattr(event.button, "id", "")
        if btn_id == "btn-back":
            self.action_go_back()
        elif btn_id == "btn-refresh":
            await self.action_refresh_logs()
