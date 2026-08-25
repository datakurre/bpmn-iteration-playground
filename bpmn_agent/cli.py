"""`bpmn` console-script entry point.

Phases 0-1 of the meta-agent refactor (docs/meta-agent-refactor-plan.md): `init`
materialises this package's bundled BPMN templates into the current workspace's
`.agents/workflows/`, and `serve` runs the same `create_app()`/uvicorn startup
`bpmn_agent/main.py` already did. `serve`'s free port, runtime handshake, and the
`status`/`open`/`stop` companions are phase 2, layered on here rather than replacing it.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import uvicorn

from bpmn_agent.agents_root import Workspace
from bpmn_agent.registry import BUNDLED_WORKFLOWS_DIR


def _materialize_bundled_workflows(workspace: Workspace) -> tuple[int, int]:
    """Copy this package's bundled `*.bpmn` templates into `workspace.workflows_dir`.

    Never overwrites a file already there, the same convention `ShellAdapter`'s own
    `template=` scaffolding uses: a workspace's templates are meant to be edited, and a
    second `bpmn init` (a version upgrade, say) must not silently discard those edits.
    Returns (copied, skipped).
    """
    copied = 0
    skipped = 0
    for src in sorted(BUNDLED_WORKFLOWS_DIR.glob("*.bpmn")):
        dst = workspace.workflows_dir / src.name
        if dst.exists():
            skipped += 1
            continue
        shutil.copyfile(src, dst)
        copied += 1
    return copied, skipped


def _cmd_init(workspace_root: Path | None) -> None:
    workspace = Workspace.discover(workspace_root)
    workspace.ensure()
    copied, skipped = _materialize_bundled_workflows(workspace)

    print(f"Initialized workspace at {workspace.root}")
    print(f"  .agents/workflows/: {copied} template(s) added, {skipped} already present")
    if not workspace.is_git:
        print(
            "  Note: this directory isn't a git repository. Savepoints and retries still "
            "work, but a savepoint fork won't be able to restore the workspace files it "
            "captured -- run `git init` here to enable that."
        )


def _cmd_serve(host: str, port: int, reload: bool) -> None:
    uvicorn.run("bpmn_agent.api.server:app", host=host, port=port, reload=reload)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="bpmn", description="Run and manage the BPMN agent.")
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init", help="Set up .agents/ in the current (or given) workspace")
    p_init.add_argument("--workspace", type=Path, default=None, help="Workspace root (default: discovered)")

    p_serve = sub.add_parser("serve", help="Run the web server (default when no command is given)")
    p_serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    p_serve.add_argument("--reload", action="store_true", help="Enable auto-reload for development")

    args = parser.parse_args(argv)

    if args.command == "init":
        _cmd_init(args.workspace)
    elif args.command in (None, "serve"):
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 8000)
        reload = getattr(args, "reload", False)
        _cmd_serve(host, port, reload)


if __name__ == "__main__":
    main()
