"""`graph-agent` console-script entry point.

Phases 0-2 of the meta-agent refactor (docs/meta-agent-refactor-plan.md): `init`
materialises this package's bundled BPMN templates into the current workspace's
`.agents/workflows/`; `serve` binds a free loopback port, mints a per-daemon bearer token,
and writes the `.agents/runtime.json` handshake a second `graph-agent` invocation reads;
`status`/`open`/`stop` are that second invocation. `--reload` is the one path that still
runs the old way (a bare `uvicorn.run` on an import string) -- reload mode re-execs via
that string in a subprocess uvicorn manages itself, which a pre-bound socket and an
in-process app object can't participate in, and it's a foreground dev loop anyway, not the
daemon this phase is otherwise building.
"""

from __future__ import annotations

import argparse
import os
import shutil
import webbrowser
from datetime import UTC, datetime
from pathlib import Path

import uvicorn

from graph_agent.agents_root import Workspace
from graph_agent.daemon import (
    RUNTIME_SCHEMA_VERSION,
    RuntimeInfo,
    bind_free_port,
    generate_token,
    is_daemon_alive,
    read_runtime_file,
    remove_runtime_file,
    stop_daemon,
    write_runtime_file,
)
from graph_agent.registry import BUNDLED_WORKFLOWS_DIR


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
            "  Note: this directory isn't a git repository, so agent turns will run "
            "in-place -- directly in this directory, one at a time -- rather than in an "
            "isolated git worktree. Savepoints and retries still work, but a savepoint "
            "fork won't be able to restore the workspace files it captured. In-place "
            "mode also gives an agent turn read/write access to .agents/ itself (this "
            "workspace's state and its daemon's runtime token), not just your project "
            "files -- run `git init` here to switch to the isolated worktree mode."
        )


def _cmd_serve(workspace_root: Path | None, host: str, port: int, reload: bool) -> None:
    if reload:
        uvicorn.run("graph_agent.api.server:app", host=host, port=port or 8000, reload=True)
        return

    workspace = Workspace.discover(workspace_root)
    workspace.ensure()

    existing = read_runtime_file(workspace)
    if existing is not None:
        if is_daemon_alive(existing):
            print(f"Already running at {existing.url}")
            return
        remove_runtime_file(workspace)

    # Imported here, not at module level: init/status/open/stop never need FastAPI, all the
    # routers, and the rest of the app-construction machinery loaded at all.
    from graph_agent.api.server import create_app

    sock = bind_free_port(host, port)
    bound_port = sock.getsockname()[1]
    token = generate_token()
    os.environ["ADMIN_TOKEN"] = token
    url = f"http://{host}:{bound_port}"

    info = RuntimeInfo(
        schema=RUNTIME_SCHEMA_VERSION,
        pid=os.getpid(),
        port=bound_port,
        url=url,
        token=token,
        started_at=datetime.now(UTC).isoformat(),
    )
    write_runtime_file(workspace, info)
    print(f"graph-agent · {workspace.root.name} · {url}")

    app = create_app(workspace=workspace)
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=bound_port))
    try:
        server.run(sockets=[sock])
    finally:
        remove_runtime_file(workspace)


def _cmd_status(workspace_root: Path | None) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None:
        print(f"No daemon running for {workspace.root}")
        return
    if not is_daemon_alive(info):
        print(f"Stale runtime info for {workspace.root} -- run `graph-agent serve` to start fresh")
        return
    print(f"graph-agent · {workspace.root.name} · {info.url}")


def _cmd_open(workspace_root: Path | None) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    webbrowser.open(info.url)
    print(f"Opened {info.url}")


def _cmd_stop(workspace_root: Path | None) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None:
        print(f"No daemon running for {workspace.root}")
        return
    if stop_daemon(workspace):
        print(f"Stopped the daemon for {workspace.root}")
    else:
        print(f"Timed out waiting for the daemon (pid {info.pid}) to stop")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="graph-agent", description="Run and manage the Graph agent.")
    sub = parser.add_subparsers(dest="command")

    def add_workspace_flag(p: argparse.ArgumentParser) -> None:
        p.add_argument("--workspace", type=Path, default=None, help="Workspace root (default: discovered)")

    p_init = sub.add_parser("init", help="Set up .agents/ in the current (or given) workspace")
    add_workspace_flag(p_init)

    p_serve = sub.add_parser("serve", help="Run the web server (default when no command is given)")
    add_workspace_flag(p_serve)
    p_serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=0, help="Bind port (default: 0, a free port)")
    p_serve.add_argument("--reload", action="store_true", help="Enable auto-reload for development")

    p_status = sub.add_parser("status", help="Show the running daemon's URL, if any")
    add_workspace_flag(p_status)

    p_open = sub.add_parser("open", help="Open the running daemon in a browser")
    add_workspace_flag(p_open)

    p_stop = sub.add_parser("stop", help="Stop the running daemon")
    add_workspace_flag(p_stop)

    args = parser.parse_args(argv)

    if args.command == "init":
        _cmd_init(args.workspace)
    elif args.command == "status":
        _cmd_status(args.workspace)
    elif args.command == "open":
        _cmd_open(args.workspace)
    elif args.command == "stop":
        _cmd_stop(args.workspace)
    elif args.command in (None, "serve"):
        workspace_root = getattr(args, "workspace", None)
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 0)
        reload = getattr(args, "reload", False)
        _cmd_serve(workspace_root, host, port, reload)


if __name__ == "__main__":
    main()
