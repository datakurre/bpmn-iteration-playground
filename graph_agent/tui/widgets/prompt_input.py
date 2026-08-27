"""Prompt input bar widget with Input widget, badges, history, and slash commands."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from textual.containers import Container
    from textual.message import Message
else:
    try:
        from textual.containers import Container
        from textual.message import Message
    except ImportError:

        class Container:  # type: ignore[no-redef]
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

        class Message:  # type: ignore[no-redef]
            pass


class PromptBar(Container):
    """Rich conversational input bar with mode indicator, Input box, and slash-command routing."""

    DEFAULT_CSS = """
    PromptBar {
        height: 5;
        dock: bottom;
        background: $surface;
        border-top: solid $accent;
        padding: 0 1;
    }

    #prompt-meta {
        height: 1;
        margin-bottom: 0;
    }

    #prompt-mode-badge {
        width: 14;
        color: $accent;
        text-style: bold;
    }

    #prompt-hints {
        color: $text-muted;
    }

    #prompt-input {
        height: 3;
        background: $surface-darken-1;
        border: round $primary;
    }
    """

    class Submitted(Message):
        """Event emitted when the user presses Enter."""

        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    class SlashCommand(Message):
        """Event emitted when the user runs a /command."""

        def __init__(self, command: str, args: str = "") -> None:
            super().__init__()
            self.command = command
            self.args = args

    def __init__(self, mode: str = "PROMPT", placeholder: str = "Type your prompt or /command and press Enter...", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.mode = mode
        self.placeholder_text = placeholder
        self.history: list[str] = []
        self.history_index: int = -1

    def compose(self) -> Any:
        from textual.containers import Horizontal
        from textual.widgets import Input, Static

        with Horizontal(id="prompt-meta"):
            yield Static(f"[{self.mode}]", id="prompt-mode-badge")
            yield Static("Enter: Send · /diff · /retry · /cancel · /purge · /help", id="prompt-hints")
        yield Input(id="prompt-input", placeholder=self.placeholder_text)

    def focus_input(self) -> None:
        from textual.widgets import Input

        with contextlib.suppress(Exception):
            self.query_one("#prompt-input", Input).focus()

    def set_mode(self, mode: str, placeholder: str = "") -> None:
        from textual.widgets import Input, Static

        self.mode = mode
        if placeholder:
            self.placeholder_text = placeholder
        try:
            badge = self.query_one("#prompt-mode-badge", Static)
            badge.update(f"[{self.mode}]")
            inp = self.query_one("#prompt-input", Input)
            if placeholder:
                inp.placeholder = placeholder
        except Exception:
            pass

    def on_input_submitted(self, event: Any) -> None:
        text = event.value.strip()
        if not text:
            return

        self.history.append(text)
        self.history_index = len(self.history)
        event.input.value = ""

        if text.startswith("/"):
            parts = text[1:].split(maxsplit=1)
            cmd = parts[0]
            args = parts[1] if len(parts) > 1 else ""
            self.post_message(self.SlashCommand(cmd, args))
        else:
            self.post_message(self.Submitted(text))

