"""Prompt input bar widget with multiline input, badges, history, and slash commands."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

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
    """Rich conversational input bar with mode indicator, multiline, and slash-command routing."""

    DEFAULT_CSS = """
    PromptBar {
        height: 6;
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

    #prompt-textarea {
        height: 4;
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

    BINDINGS: ClassVar[list[Any]] = [
        ("enter", "submit_prompt", "Send"),
    ]

    def __init__(self, mode: str = "PROMPT", placeholder: str = "Type a message or /command...", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.mode = mode
        self.placeholder_text = placeholder
        self.history: list[str] = []
        self.history_index: int = -1

    def compose(self) -> Any:
        from textual.containers import Horizontal
        from textual.widgets import Static, TextArea

        with Horizontal(id="prompt-meta"):
            yield Static(f"[{self.mode}]", id="prompt-mode-badge")
            yield Static("Enter: Send · Shift+Enter: Newline · /diff · /palette · /editor", id="prompt-hints")
        yield TextArea(id="prompt-textarea", show_line_numbers=False)

    def set_mode(self, mode: str, placeholder: str = "") -> None:
        from textual.widgets import Static

        self.mode = mode
        if placeholder:
            self.placeholder_text = placeholder
        try:
            badge = self.query_one("#prompt-mode-badge", Static)
            badge.update(f"[{self.mode}]")
        except Exception:
            pass

    def action_submit_prompt(self) -> None:
        from textual.widgets import TextArea

        try:
            area = self.query_one("#prompt-textarea", TextArea)
            text = area.text.strip()
            if not text:
                return

            self.history.append(text)
            self.history_index = len(self.history)
            area.text = ""

            if text.startswith("/"):
                parts = text[1:].split(maxsplit=1)
                cmd = parts[0]
                args = parts[1] if len(parts) > 1 else ""
                self.post_message(self.SlashCommand(cmd, args))
            else:
                self.post_message(self.Submitted(text))
        except Exception:
            pass
