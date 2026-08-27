"""Start workflow screen with template picker and variable inputs."""

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


class StartScreen(Screen):  # type: ignore
    """Screen for launching a new workflow run from a template."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("ctrl+s", "launch", "Launch"),
        ("escape", "go_back", "Back"),
        ("b", "go_back", "Back"),
    ]

    def __init__(self, name: str | None = None, id: str | None = None, classes: str | None = None) -> None:
        super().__init__(name=name, id=id, classes=classes)
        self.templates: list[dict[str, Any]] = []

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, VerticalScroll
            from textual.widgets import Footer, Header, Input, Label, Select, Static, TextArea

            yield Header(show_clock=True)
            with Container(id="start-container"):
                yield Static("[b]Start New Workflow Run[/b]  (Ctrl+S: Launch, b/Esc: Back)", id="start-header")
                with VerticalScroll(id="start-form"):
                    yield Label("Select BPMN Template:")
                    yield Select([], id="select-template", prompt="Choose a template...")
                    yield Label("Template Description:", id="lbl-template-desc")
                    yield Static("Select a template to view details.", id="template-desc-text")

                    yield Label("Feature Request / Goal / Prompt:")
                    yield TextArea("", id="input-goal")

                    yield Label("Additional Variables (JSON, optional):")
                    yield Input("{}", id="input-extra-vars")

            yield Footer()
        except ImportError:
            pass

    async def on_mount(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            from textual.widgets import Select

            self.templates = await client.get_templates()
            options = []
            for t in self.templates:
                pid = t.get("process_id") or t.get("id", "")
                name = t.get("name") or pid
                options.append((f"{name} ({pid})", str(t.get("path") or pid)))

            sel = self.query_one("#select-template", Select)
            sel.set_options(options)
            if options:
                sel.value = options[0][1]
        except Exception as exc:
            self.notify(f"Failed to load templates: {exc}", severity="error")

    def on_select_changed(self, event: Any) -> None:
        try:
            from textual.widgets import Static

            sel_path = str(event.value)
            desc = "No description available."
            for t in self.templates:
                if str(t.get("path") or t.get("id")) == sel_path:
                    desc = t.get("description") or "No description available."
                    break
            self.query_one("#template-desc-text", Static).update(desc)
        except Exception:
            pass

    async def action_launch(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return

        try:
            import json

            from textual.widgets import Input, Select, TextArea

            sel = self.query_one("#select-template", Select)
            if not sel.value:
                self.notify("Please select a template first", severity="warning")
                return

            bpmn_path = str(sel.value)
            goal_text = self.query_one("#input-goal", TextArea).text.strip()
            extra_str = self.query_one("#input-extra-vars", Input).value.strip()

            variables: dict[str, Any] = {}
            if extra_str:
                try:
                    variables = json.loads(extra_str)
                except Exception as exc:
                    self.notify(f"Invalid JSON in extra variables: {exc}", severity="error")
                    return

            if goal_text:
                variables["goal"] = goal_text
                variables["feature_request"] = goal_text

            started = await client.start_run(bpmn_path, variables)
            wid = started.get("workflow_id")
            self.notify(f"Launched workflow {wid[:8]}!", severity="information")
            self.app.pop_screen()
            if wid:
                from graph_agent.tui.screens.detail import RunDetailScreen

                self.app.push_screen(RunDetailScreen(workflow_id=wid))

        except Exception as exc:
            self.notify(f"Failed to start workflow: {exc}", severity="error")

    def action_go_back(self) -> None:
        self.app.pop_screen()

    async def on_button_pressed(self, event: Any) -> None:
        btn_id = getattr(event.button, "id", "")
        if btn_id == "btn-launch":
            await self.action_launch()
        elif btn_id == "btn-cancel":
            self.action_go_back()
