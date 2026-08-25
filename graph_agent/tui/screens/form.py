"""Form screen for rendering FormJS human tasks natively or linking to browser."""

from __future__ import annotations

import webbrowser
from typing import TYPE_CHECKING, Any, ClassVar

from graph_agent.tui.forms import FormSchema

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


class FormScreen(Screen):  # type: ignore[misc]
    """Renders FormJS form components natively, or falls back to browser deep link for complex forms."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "go_back", "Back"),
        ("b", "go_back", "Back"),
        ("o", "open_in_browser", "Open in Browser"),
    ]

    def __init__(
        self,
        workflow_id: str,
        task_id: str | None = None,
        name: str | None = None,
        id: str | None = None,
        classes: str | None = None,
    ) -> None:
        super().__init__(name=name, id=id, classes=classes)
        self.workflow_id = workflow_id
        self.task_id = task_id
        self.form_schema: FormSchema | None = None
        self.raw_data: dict[str, Any] = {}

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, Horizontal, VerticalScroll
            from textual.widgets import Button, Footer, Header, Static

            yield Header(show_clock=True)
            with Container(id="form-container"):
                yield Static(f"[b]Human Task Form: {self.workflow_id[:8]}[/b]", id="form-header")
                with VerticalScroll(id="form-fields-container"):
                    yield Static("Loading form fields...", id="form-loading")
                with Horizontal(id="form-actions"):
                    yield Button("Submit Form", id="btn-submit", variant="primary")
                    yield Button("Open in Browser [o]", id="btn-browser")
                    yield Button("Cancel [b/Esc]", id="btn-cancel")
            yield Footer()
        except ImportError:
            pass

    async def _mount_field(self, f: Any, fields_container: Any) -> None:
        from textual.widgets import Checkbox, Input, Label, RadioButton, RadioSet, Select, Static, TextArea

        if f.type in ("text", "markdown"):
            await fields_container.mount(Static(f.text_content or f.label or ""))
        elif f.type == "checkbox":
            await fields_container.mount(Checkbox(f.label, value=bool(f.default_value), id=f"field-{f.key}"))
        elif f.type == "textarea":
            await fields_container.mount(Label(f.label))
            await fields_container.mount(TextArea(str(f.default_value or ""), id=f"field-{f.key}"))
        elif f.type == "select" and f.options:
            await fields_container.mount(Label(f.label))
            opts = [(opt.label, opt.value) for opt in f.options]
            await fields_container.mount(
                Select(opts, value=str(f.default_value or f.options[0].value), id=f"field-{f.key}")
            )
        elif f.type == "radio" and f.options:
            await fields_container.mount(Label(f.label))
            with RadioSet(id=f"field-{f.key}") as rset:
                for opt in f.options:
                    await rset.mount(RadioButton(opt.label, value=(opt.value == f.default_value)))
        else:
            await fields_container.mount(Label(f.label))
            val_str = str(f.default_value) if f.default_value is not None else ""
            await fields_container.mount(
                Input(value=val_str, placeholder=f.description or f.label, id=f"field-{f.key}")
            )

    async def on_mount(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return

        try:
            import contextlib

            from textual.containers import VerticalScroll
            from textual.widgets import Static

            form_dict = {}
            if self.task_id:
                with contextlib.suppress(Exception):
                    form_dict = await client.get_form(self.workflow_id, self.task_id)

            if not form_dict:
                run_state = await client.get_run(self.workflow_id)
                for t in run_state.get("tasks", []):
                    if t.get("state") == "READY" and (not self.task_id or t.get("id") == self.task_id):
                        self.task_id = t.get("id")
                        form_dict = t.get("form") or {}
                        break

            schema_data = form_dict.get("schema") or form_dict
            self.form_schema = FormSchema.from_dict(schema_data)

            fields_container = self.query_one("#form-fields-container", VerticalScroll)
            await fields_container.remove_children()

            if not self.form_schema.fields:
                await fields_container.mount(
                    Static("No specific form fields defined for this task. Click Submit to approve/complete.")
                )
                return

            if not self.form_schema.is_native_supported:
                unsupported_str = ", ".join(self.form_schema.unsupported_types)
                await fields_container.mount(
                    Static(
                        f"[yellow]Notice: This form contains rich FormJS components ({unsupported_str}) "
                        "best viewed in the browser.[/yellow]\n\n"
                        f"Deep link: {client.base_url}/instance/{self.workflow_id}"
                    )
                )

            for f in self.form_schema.fields:
                await self._mount_field(f, fields_container)

        except Exception as exc:
            self.notify(f"Error loading form: {exc}", severity="error")

    def collect_form_data(self) -> dict[str, Any]:
        """Read values from active input widgets."""
        data: dict[str, Any] = {}
        if not self.form_schema:
            return data

        for f in self.form_schema.fields:
            if not f.key or f.type in ("text", "markdown", "button"):
                continue
            try:
                from textual.widgets import Checkbox, Input, Select, TextArea

                if f.type == "checkbox":
                    cb = self.query_one(f"#field-{f.key}", Checkbox)
                    data[f.key] = cb.value
                elif f.type == "textarea":
                    ta = self.query_one(f"#field-{f.key}", TextArea)
                    data[f.key] = ta.text
                elif f.type == "select":
                    sel = self.query_one(f"#field-{f.key}", Select)
                    data[f.key] = sel.value
                elif f.type == "number":
                    inp = self.query_one(f"#field-{f.key}", Input)
                    try:
                        data[f.key] = float(inp.value) if "." in inp.value else int(inp.value)
                    except ValueError:
                        data[f.key] = inp.value
                else:
                    inp = self.query_one(f"#field-{f.key}", Input)
                    data[f.key] = inp.value
            except Exception:
                if f.default_value is not None:
                    data[f.key] = f.default_value

        return data

    async def action_submit(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return

        if not self.task_id:
            self.notify("No task ID associated with this form", severity="error")
            return

        data = self.collect_form_data()
        try:
            await client.submit_task(self.workflow_id, self.task_id, data)
            self.notify("Task submitted successfully!", severity="information")
            self.app.pop_screen()
        except Exception as exc:
            self.notify(f"Submit error: {exc}", severity="error")

    def action_open_in_browser(self) -> None:
        client = getattr(self.app, "client", None)
        base_url = getattr(client, "base_url", "http://127.0.0.1:8000")
        url = f"{base_url}/instance/{self.workflow_id}"
        try:
            webbrowser.open(url)
            self.notify(f"Opened {url} in browser", severity="information")
        except Exception as exc:
            self.notify(f"Failed to open browser: {exc}", severity="error")

    def action_go_back(self) -> None:
        self.app.pop_screen()

    async def on_button_pressed(self, event: Any) -> None:
        btn_id = getattr(event.button, "id", "")
        if btn_id == "btn-submit":
            await self.action_submit()
        elif btn_id == "btn-browser":
            self.action_open_in_browser()
        elif btn_id == "btn-cancel":
            self.action_go_back()
