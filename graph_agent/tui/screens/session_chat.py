"""Interactive Conversational REPL screen for graph-agent BPMN sessions."""

from __future__ import annotations

import contextlib
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


class SessionChatScreen(Screen):  # type: ignore
    """Flagship conversational chat REPL driven by SpiffWorkflow BPMN instances."""

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "go_back", "Back"),
        ("ctrl+d", "open_diff", "Diff"),
        ("ctrl+p", "open_palette", "Commands"),
        ("ctrl+e", "open_editor", "Modeler"),
        ("ctrl+s", "take_screenshot", "Screenshot"),
        ("w", "open_browser", "Web UI"),
        ("m", "merge_session", "Merge"),
        ("c", "cancel_session", "Cancel"),
        ("x", "delete_session", "Purge"),
        ("t", "retry_failed", "Retry"),
        ("r", "refresh_session", "Refresh"),
    ]

    DEFAULT_CSS = """
    SessionChatScreen {
        background: $surface;
        color: $text;
    }

    #chat-container {
        height: 100%;
        padding: 0 1;
    }

    #chat-scroll {
        height: 1fr;
        border: round $primary;
        background: $surface-darken-1;
        padding: 1;
        overflow-y: scroll;
    }

    .chat-welcome-banner {
        background: $panel;
        color: $text;
        border: round $primary;
        padding: 1 2;
        margin-bottom: 1;
        text-align: center;
    }
    """

    def __init__(self, workflow_id: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.workflow_id = workflow_id
        self.run_state: dict[str, Any] = {}
        self.displayed_task_ids: set[str] = set()
        self.active_human_task_id: str | None = None
        self.diff_stat: str = ""

    def compose(self) -> ComposeResult:
        try:
            from textual.containers import Container, VerticalScroll
            from textual.widgets import Footer, Header

            from graph_agent.tui.widgets.bpmn_stepper import BpmnStepper
            from graph_agent.tui.widgets.prompt_input import PromptBar

            yield Header(show_clock=True)
            with Container(id="chat-container"):
                yield BpmnStepper(id="chat-stepper")
                with VerticalScroll(id="chat-scroll"):
                    pass
                yield PromptBar(id="chat-prompt-bar")
            yield Footer()
        except ImportError:
            pass

    async def on_mount(self) -> None:
        await self.action_refresh_session()
        self.focus_prompt()
        self.set_interval(2.0, self.action_refresh_session)

    def focus_prompt(self) -> None:
        with contextlib.suppress(Exception):
            from graph_agent.tui.widgets.prompt_input import PromptBar

            self.query_one("#chat-prompt-bar", PromptBar).focus_input()

    def action_take_screenshot(self) -> None:
        if hasattr(self.app, "action_take_screenshot"):
            self.app.action_take_screenshot()
        else:
            try:
                path = self.app.save_screenshot()
                self.notify(f"Screenshot saved to {path}", severity="information")
            except Exception as exc:
                self.notify(f"Screenshot failed: {exc}", severity="error")

    async def action_refresh_session(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            self.run_state = await client.get_run(self.workflow_id)

            # Update Stepper
            from graph_agent.tui.widgets.bpmn_stepper import BpmnStepper

            with contextlib.suppress(Exception):
                stepper = self.query_one("#chat-stepper", BpmnStepper)
                stepper.update_state(self.run_state)

            await self._render_chat_updates()
            await self._update_prompt_bar_mode()
        except Exception as exc:
            self.notify(f"Sync error: {exc}", severity="warning")

    async def _render_chat_updates(self) -> None:
        from textual.containers import VerticalScroll
        from textual.widgets import Static

        from graph_agent.tui.widgets.chat_message import (
            PlannerMessageCard,
            ReviewCheckpointCard,
            TaskExecutionCard,
            UserPromptBubble,
        )

        scroll = self.query_one("#chat-scroll", VerticalScroll)
        data = self.run_state.get("data", {})
        tasks = self.run_state.get("tasks", [])
        jobs = self.run_state.get("jobs", {})

        # 0. Initial welcome banner when waiting for prompt
        if "__WELCOME_RENDERED__" not in self.displayed_task_ids and not data.get("user_prompt"):
            self.displayed_task_ids.add("__WELCOME_RENDERED__")
            await scroll.mount(
                Static(
                    "💬 [bold cyan]Interactive Agent Session Ready[/bold cyan]\n"
                    "[dim]Type your goal or task in the input bar below and press Enter to formulate a plan.[/dim]\n"
                    "[dim]Commands: /diff · /retry · /cancel · /purge · /web · /help[/dim]",
                    classes="chat-welcome-banner",
                )
            )

        # 1. Render initial user prompt if present and not yet displayed
        if "user_prompt" in data and "__USER_PROMPT_RENDERED__" not in self.displayed_task_ids:
            self.displayed_task_ids.add("__USER_PROMPT_RENDERED__")
            created = (self.run_state.get("created_at") or "")[:19].replace("T", " ")
            await scroll.mount(UserPromptBubble(data["user_prompt"], timestamp=created))

        # 2. Render planner card if plan is formulated
        if "plan_summary" in data and "__PLANNER_RENDERED__" not in self.displayed_task_ids:
            self.displayed_task_ids.add("__PLANNER_RENDERED__")
            ext_spec = data.get("extension_spec") or {}
            await scroll.mount(PlannerMessageCard(data["plan_summary"], extension_spec=ext_spec))

        # 3. Render completed or running execution tasks
        for task in tasks:
            tid = task.get("id") or ""
            tname = task.get("name") or task.get("bpmn_id") or "Task"
            tstate = task.get("state", "")
            lower_name = tname.lower()

            if lower_name in (
                "prompt user",
                "formulate execution plan & graph",
                "validate bpmn & invariants",
                "apply graph extension",
            ):
                continue

            if tid not in self.displayed_task_ids and tstate in ("COMPLETED", "STARTED", "FAILED"):
                self.displayed_task_ids.add(tid)
                job = jobs.get(tid, {})
                summary = job.get("summary") or task.get("summary") or ""
                details = job.get("text") or ""
                if len(details) > 300:
                    details = f"{details[:297]}..."
                await scroll.mount(TaskExecutionCard(tname, tstate.lower(), summary=summary, details=details))

        # 4. Check if currently waiting at UserTask_Review
        for task in tasks:
            if task.get("state") == "READY" and "Review" in (task.get("name") or ""):
                if "__REVIEW_CARD_MOUNTED__" not in self.displayed_task_ids:
                    self.displayed_task_ids.add("__REVIEW_CARD_MOUNTED__")
                    # Fetch diff stat
                    client = getattr(self.app, "client", None)
                    diff_stat = ""
                    if client:
                        with contextlib.suppress(Exception):
                            diff_res = await client.get_diff(self.workflow_id)
                            diff_stat = diff_res.get("stat", "")
                    await scroll.mount(ReviewCheckpointCard(diff_stat=diff_stat))
                break

    async def _update_prompt_bar_mode(self) -> None:
        from graph_agent.tui.widgets.prompt_input import PromptBar

        with contextlib.suppress(Exception):
            bar = self.query_one("#chat-prompt-bar", PromptBar)
            status = self.run_state.get("status", "")
            tasks = self.run_state.get("tasks", [])

            # Find ready human task
            self.active_human_task_id = None
            for t in tasks:
                if t.get("state") == "READY" and (
                    t.get("type", "").lower() in ("usertask", "user_task") or "UserTask" in t.get("id", "")
                ):
                    self.active_human_task_id = t.get("id")
                    tname = t.get("name", "")
                    if "Review" in tname:
                        bar.set_mode("REVIEW", "Type 'approve' to complete & merge, or enter revision feedback...")
                    else:
                        bar.set_mode("PROMPT", "Describe what you would like to implement or modify...")
                    return

            if status in ("running", "waiting_pi", "retry_requested"):
                bar.set_mode("BUSY", "Agent turn executing in background...")
            elif status == "completed":
                bar.set_mode("DONE", "Session completed. Type a new goal to continue.")
            else:
                bar.set_mode("IDLE", "Session paused.")

    async def on_prompt_bar_submitted(self, event: Any) -> None:
        text = event.text.strip()
        if not text:
            return

        client = getattr(self.app, "client", None)
        if not client:
            return

        try:
            from textual.containers import VerticalScroll

            from graph_agent.tui.widgets.chat_message import UserPromptBubble

            scroll = self.query_one("#chat-scroll", VerticalScroll)
            await scroll.mount(UserPromptBubble(text))

            if self.active_human_task_id:
                # Check if this is review decision
                tname = ""
                for t in self.run_state.get("tasks", []):
                    if t.get("id") == self.active_human_task_id:
                        tname = t.get("name", "")
                        break

                if "Review" in tname:
                    if text.lower() in ("approve", "approved", "ok", "yes", "done", "merge"):
                        payload = {"review_decision": "approve", "review_feedback": ""}
                    elif text.lower().startswith("revise"):
                        payload = {"review_decision": "revise", "review_feedback": text}
                    else:
                        payload = {"review_decision": "continue", "review_feedback": text}
                    await client.submit_task(self.workflow_id, self.active_human_task_id, payload)
                    self.notify("Submitted review decision!", severity="information")
                else:
                    payload = {"user_prompt": text, "context": ""}
                    await client.submit_task(self.workflow_id, self.active_human_task_id, payload)
                    self.notify("Submitted prompt to planner!", severity="information")

                await self.action_refresh_session()
            else:
                self.notify("No active human task waiting for input", severity="warning")
        except Exception as exc:
            self.notify(f"Submission failed: {exc}", severity="error")

    def on_prompt_bar_slash_command(self, event: Any) -> None:
        cmd = event.command.lower().strip()
        if cmd == "diff":
            self.action_open_diff()
        elif cmd in ("palette", "menu", "p"):
            self.action_open_palette()
        elif cmd in ("editor", "modeler", "e"):
            self.action_open_editor()
        elif cmd in ("web", "browser", "w"):
            self.action_open_browser()
        elif cmd in ("screenshot", "s"):
            self.action_take_screenshot()
        elif cmd in ("retry", "t"):
            self.run_worker(self.action_retry_failed())
        elif cmd in ("cancel", "stop", "c"):
            self.run_worker(self.action_cancel_session())
        elif cmd in ("purge", "delete", "x"):
            self.run_worker(self.action_delete_session())
        elif cmd in ("merge", "m"):
            if hasattr(self, "run_worker"):
                self.run_worker(self.action_merge_session())
            else:
                import asyncio

                self._bg_task = asyncio.create_task(self.action_merge_session())
        elif cmd in ("help", "?"):
            self.notify(
                "Slash commands: /diff, /retry, /cancel, /purge, /merge, /web, /editor, /palette, /screenshot, /status",
                severity="information",
            )
        elif cmd == "status":
            st = self.run_state.get("status", "unknown")
            self.notify(f"Session {self.workflow_id[:8]}: {st}", severity="information")
        else:
            self.notify(
                f"Unknown command: /{cmd}. Valid: /diff, /retry, /cancel, /purge, /merge, /web, /editor, /palette, /help",
                severity="warning",
            )

    def action_open_diff(self) -> None:
        from graph_agent.tui.screens.diff_modal import DiffModalScreen

        self.app.push_screen(DiffModalScreen(workflow_id=self.workflow_id))

    def action_open_palette(self) -> None:
        from graph_agent.tui.screens.command_palette import CommandPaletteModal

        self.app.push_screen(CommandPaletteModal(current_workflow_id=self.workflow_id))

    def action_open_editor(self) -> None:
        import webbrowser

        client = getattr(self.app, "client", None)
        url = f"{client.base_url}/editor" if client else "http://127.0.0.1:8080/editor"
        webbrowser.open(url)
        self.notify(f"Opened {url} in browser", severity="information")

    def action_open_browser(self) -> None:
        import os
        import webbrowser

        client = getattr(self.app, "client", None)
        base_url = getattr(client, "base_url", None) or "http://127.0.0.1:8080"
        token = getattr(client, "token", None) or os.environ.get("ADMIN_TOKEN")
        query = "?dev=1" + (f"&token={token}" if token else "")
        url = f"{base_url}/instance/{self.workflow_id}{query}"
        try:
            webbrowser.open(url)
            self.notify(f"Opened Web Studio in browser ({url})", severity="information")
        except Exception as exc:
            self.notify(f"Failed to open browser: {exc}", severity="error")

    async def action_merge_session(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            res = await client.merge_run(self.workflow_id)
            st = res.get("status")
            if st == "merged":
                self.notify(f"Merged session {self.workflow_id[:8]} into base branch!", severity="information")
            else:
                self.notify(f"Merge: {res.get('message', st)}", severity="warning")
            await self.action_refresh_session()
        except Exception as exc:
            self.notify(f"Merge error: {exc}", severity="error")

    async def action_retry_failed(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        tasks = self.run_state.get("tasks", [])
        failed_tasks = [t for t in tasks if t.get("state") == "STARTED"]
        if not failed_tasks:
            self.notify("No failed tasks found to retry", severity="warning")
            return
        target = failed_tasks[0]
        try:
            await client.retry_task(self.workflow_id, target["id"])
            self.notify(f"Retrying task {target.get('name')}", severity="information")
            await self.action_refresh_session()
        except Exception as exc:
            self.notify(f"Retry error: {exc}", severity="error")

    async def action_cancel_session(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            res = await client.cancel_run(self.workflow_id)
            self.notify(f"Cancelled session {self.workflow_id[:8]} (status: {res.get('status')})", severity="information")
            await self.action_refresh_session()
        except Exception as exc:
            self.notify(f"Cancel error: {exc}", severity="error")

    async def action_delete_session(self) -> None:
        client = getattr(self.app, "client", None)
        if not client:
            return
        try:
            await client.delete_run(self.workflow_id)
            self.notify(f"Purged session {self.workflow_id[:8]}", severity="information")
            self.app.pop_screen()
        except Exception as exc:
            self.notify(f"Purge error: {exc}", severity="error")

    def action_go_back(self) -> None:
        self.app.pop_screen()
