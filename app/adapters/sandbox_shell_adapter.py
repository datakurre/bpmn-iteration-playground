from __future__ import annotations

import logging
from dataclasses import replace
from pathlib import Path

from app.adapters.base import AdapterCapabilities
from app.adapters.sandbox_policy import (
    DEFAULT_SHELL_SANDBOX_TEMPLATE,
    prepare_sandbox_workspace,
    resolve_sandbox_command_prefix,
    workspace_policy_declares_routes,
)
from app.adapters.shell_adapter import ShellAdapter

logger = logging.getLogger("bpmn.sandbox_shell_adapter")


class SandboxShellAdapter(ShellAdapter):
    """Runs a declared shell command inside agent-sandbox instead of directly on the host.

    Same BPMN properties as `ShellAdapter` (command/shell/workdir/timeout/artifacts/...);
    the only difference is how the command is spawned -- wrapped as
    `agent-sandbox --workspace --proxy [--secrets] -- <argv>` (mirroring `SandboxPiAdapter`)
    so a deterministic pipeline step gets the same Podman isolation Pi turns get. Because
    `--workspace` mounts the *subprocess's* cwd (not necessarily the instance workspace
    root -- a declared `workdir` narrows it, same as the unsandboxed adapter), and the
    launcher points the container's own `--workdir` at that mount, no in-container `cd` is
    needed: `_resolve_invocation`'s `run_dir` already carries that through unchanged.

    `--secrets` is added only when the workspace's rendered policy actually declares a
    route: it resolves every declared route eagerly and refuses to launch at all if any
    can't be satisfied, so passing it unconditionally would make a task that needs no
    secrets (a compiler, a slicer) fail to start over a route it never uses -- see
    `workspace_policy_declares_routes`.
    """

    def __init__(self, executable: str | None = None, timeout_seconds: float | None = None) -> None:
        super().__init__(timeout_seconds=timeout_seconds)
        self.command_prefix = resolve_sandbox_command_prefix(executable)

    @property
    def adapter_type(self) -> str:
        return "sandbox_shell"

    @property
    def capabilities(self) -> AdapterCapabilities:
        return replace(super().capabilities, display_name="Shell Command (sandboxed)")

    async def prepare_workspace(self, workdir: str, config: dict[str, str]) -> None:
        """Scaffold any declared template, then render this task's network policy into AGENTS.md."""
        await super().prepare_workspace(workdir, config)
        prepare_sandbox_workspace(workdir, config, default_template=DEFAULT_SHELL_SANDBOX_TEMPLATE)

    def _resolve_invocation(  # type: ignore[override]
        self, command: str, config: dict[str, str], cwd: str
    ) -> tuple[list[str], Path] | str:
        resolved = ShellAdapter._resolve_invocation(command, config, cwd)
        if isinstance(resolved, str):
            return resolved
        argv, run_dir = resolved
        sandbox_flags = ["--workspace", "--proxy"]
        if workspace_policy_declares_routes(cwd):
            sandbox_flags.append("--secrets")
        sandboxed = [*self.command_prefix, *sandbox_flags, "--", *argv]
        logger.info(f"Executing agent-sandbox: {' '.join(sandboxed)} (cwd: {run_dir})")
        return sandboxed, run_dir
