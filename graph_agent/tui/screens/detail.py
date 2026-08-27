"""Run Detail Screen for graph-agent TUI."""

from __future__ import annotations

import json
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


class RunDetailScreen(Screen):  # type: ignore
    """Detailed view of a single workflow run: timeline, live logs, variables, and savepoints."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "go_back", "Back"),
        ("b", "go_back", "Back"),
        ("r", "refresh_detail", "Refresh"),
        ("t", "retry_task", "Retry Task"),
        ("m", "merge_run", "Merge"),
        ("c", "cancel_run", "Cancel"),
        ("x", "delete_run", "Purge"),
        ("w", "open_in_browser", "Web UI"),
    ]

    def __init__(
        self,
        workflow_id: str,
        name: str | None = None,
        id: str | None = None,
        classes: str | None = None,
    ) -> None:
        super().__init__(name=name, id=id, classes=classes)
        self.workflow_id = workflow_id
        self.run_data: dict[str, Any] = {}

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, Horizontal, VerticalScroll
            from textual.widgets import DataTable, Footer, Header, RichLog, Static, TabbedContent, TabPane

            yield Header(show_clock=True)
            with Container(id="detail-container"):
                yield Static(f"[b]Run Detail: {self.workflow_id}[/b]", id="detail-header")
                with Horizontal(id="detail-meta"):
                    yield Static("Loading metadata...", id="detail-meta-text")

                with TabbedContent(initial="tab-timeline"):
                    with TabPane("Timeline", id="tab-timeline"):
                        yield DataTable(id="detail-tasks-table", cursor_type="row")
                    with TabPane("Live Logs & Output", id="tab-output"):
                        yield RichLog(id="detail-rich-log", highlight=True, markup=True)
                    with TabPane("Workflow Data", id="tab-variables"), VerticalScroll():
                        yield Static("{}", id="detail-variables-json")
                    with TabPane("Savepoints", id="tab-savepoints"):
                        yield DataTable(id="detail-savepoints-table", cursor_type="row")
            yield Footer()
        except ImportError:
            pass

    async def on_mount(self) -> None:
        import contextlib
        from textual.widgets import DataTable

        with contextlib.suppress(Exception):
            tasks_table = self.query_one("#detail-tasks-table", DataTable)
            tasks_table.add_columns("Task ID", "Name", "Type", "State", "Attempts", "Failure Reason")

        with contextlib.suppress(Exception):
            sp_table = self.query_one("#detail-savepoints-table", DataTable)
            sp_table.add_columns("Savepoint ID", "Phase", "Task", "Created At")

        try:
            await self.action_refresh_detail()
            self.set_interval(2.5, self.action_refresh_detail)
        except Exception as exc:
            self.notify(f"Mount error: {exc}", severity="warning")

    async def action_refresh_detail(self) -> None:
        client = getattr(self.app, "client", None)
        if not client or not self.workflow_id:
            return
        try:
            from textual.widgets import DataTable, RichLog, Static

            self.run_data = await client.get_run(self.workflow_id)
            status = self.run_data.get("status", "unknown")
            merge_status = self.run_data.get("merge_status") or "none"
            bpmn_path = self.run_data.get("bpmn_path", "unknown")

            meta_text = (
                f"[b]Status:[/b] {status}  |  "
                f"[b]Template:[/b] {bpmn_path}  |  "
                f"[b]Merge:[/b] {merge_status}  |  "
                f"[b]Updated:[/b] {self.run_data.get('updated_at', '')[:19]}"
            )
            self.query_one("#detail-meta-text", Static).update(meta_text)

            # Update tasks table
            tasks_table = self.query_one("#detail-tasks-table", DataTable)
            tasks_table.clear()
            tasks = self.run_data.get("tasks", [])
            for t in tasks:
                tid = str(t.get("id", ""))
                tname = str(t.get("name") or t.get("bpmn_name") or "Task")
                ttype = str(t.get("type", ""))
                tstate = str(t.get("state", ""))
                attempts = str(t.get("attempts", 1))
                failure = str(t.get("failure_reason") or "-")
                tasks_table.add_row(tid[:8], tname, ttype, tstate, attempts, failure, key=tid)

            # Update savepoints table
            sp_table = self.query_one("#detail-savepoints-table", DataTable)
            sp_table.clear()
            for sp in self.run_data.get("save_points", []):
                spid = str(sp.get("id", ""))
                phase = str(sp.get("phase", ""))
                tname = str(sp.get("task_name") or sp.get("task_id") or "-")
                created = (sp.get("created_at") or "")[:19].replace("T", " ")
                sp_table.add_row(spid[:8], phase, tname, created, key=spid)

            # Update variables JSON
            wf_data = self.run_data.get("data", {})
            try:
                formatted_json = json.dumps(wf_data, indent=2, default=str)
            except Exception:
                formatted_json = str(wf_data)
            self.query_one("#detail-variables-json", Static).update(formatted_json)

            # Update rich log with latest task output if present
            rich_log = self.query_one("#detail-rich-log", RichLog)
            jobs = self.run_data.get("jobs", {})
            rich_log.clear()
            if not jobs:
                rich_log.write("No turn execution outputs recorded yet.")
            else:
                for jid, job in jobs.items():
                    jname = str(job.get("task_name", jid[:8]))
                    jstatus = str(job.get("status", ""))
                    rich_log.write(f"[bold cyan]== Task: {jname} ({jstatus}) ==[/bold cyan]")
                    if job.get("prompt"):
                        prompt_str = str(job.get("prompt", ""))
                        rich_log.write(f"[yellow]Prompt:[/yellow] {prompt_str[:300]}...")
                    if job.get("text"):
                        rich_log.write(f"[green]Output:[/green]\n{job.get('text')!s}")
                    if job.get("stderr"):
                        rich_log.write(f"[red]Stderr:[/red]\n{job.get('stderr')!s}")
                    if job.get("failure_reason"):
                        rich_log.write(f"[bold red]Failure:[/bold red] {job.get('failure_reason')!s}")
                    rich_log.write("\n" + "-" * 50 + "\n")

        except Exception as exc:
            self.notify(f"Error refreshing detail: {exc}", severity="error")

    def action_go_back(self) -> None:
        self.app.pop_screen()

    async def action_retry_task(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        # Find first failed task
        failed_task = None
        for t in self.run_data.get("tasks", []):
            if t.get("state") in ("STARTED", "READY") and t.get("failure_reason"):
                failed_task = t.get("id")
                break
        if not failed_task:
            for jid, job in self.run_data.get("jobs", {}).items():
                if job.get("status") == "failed":
                    failed_task = jid
                    break
        if not failed_task:
            self.notify("No failed task found to retry", severity="warning")
            return
        try:
            await client.retry_task(self.workflow_id, failed_task)
            self.notify(f"Retrying task {failed_task[:8]}", severity="information")
            await self.action_refresh_detail()
        except Exception as exc:
            self.notify(f"Retry failed: {exc}", severity="error")

    async def action_merge_run(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            res = await client.merge_run(self.workflow_id)
            self.notify(f"Merge: {res.get('status')} - {res.get('message')}", severity="information")
            await self.action_refresh_detail()
        except Exception as exc:
            self.notify(f"Merge error: {exc}", severity="error")

    async def action_cancel_run(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            await client.cancel_run(self.workflow_id)
            self.notify(f"Cancelled run {self.workflow_id[:8]}", severity="information")
            await self.action_refresh_detail()
        except Exception as exc:
            self.notify(f"Cancel error: {exc}", severity="error")

    async def action_delete_run(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            await client.delete_run(self.workflow_id)
            self.notify(f"Purged run {self.workflow_id[:8]}", severity="information")
            self.app.pop_screen()
        except Exception as exc:
            self.notify(f"Purge error: {exc}", severity="error")

    def action_open_in_browser(self) -> None:
        import os
        import webbrowser

        from graph_agent.agents_root import Workspace
        from graph_agent.daemon import read_runtime_file

        client = getattr(self.app, "client", None)
        base_url = getattr(client, "base_url", None)
        token = getattr(client, "token", None)
        if not base_url or not token:
            ws = getattr(self.app, "workspace", None) or Workspace.discover()
            runtime = read_runtime_file(ws)
            if runtime:
                base_url = base_url or runtime.url
                token = token or runtime.token
        base_url = base_url or "http://127.0.0.1:8080"
        token = token or os.environ.get("ADMIN_TOKEN")
        query = f"?token={token}" if token else ""
        url = f"{base_url}/instance/{self.workflow_id}{query}"
        try:
            webbrowser.open(url)
            self.notify(f"Opened {url} in browser", severity="information")
        except Exception as exc:
            self.notify(f"Failed to open browser: {exc}", severity="error")

    async def on_button_pressed(self, event: Any) -> None:
        btn_id = getattr(event.button, "id", "")
        if btn_id == "btn-back":
            self.action_go_back()
        elif btn_id == "btn-refresh":
            await self.action_refresh_detail()
        elif btn_id == "btn-retry":
            await self.action_retry_task()
        elif btn_id == "btn-merge":
            await self.action_merge_run()
        elif btn_id == "btn-cancel":
            await self.action_cancel_run()
        elif btn_id == "btn-browser":
            self.action_open_in_browser()
