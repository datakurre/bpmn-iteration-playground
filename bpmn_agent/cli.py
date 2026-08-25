"""`bpmn` console-script entry point.

Phases 0-2 of the meta-agent refactor (docs/meta-agent-refactor-plan.md): `init`
materialises this package's bundled BPMN templates into the current workspace's
`.agents/workflows/`; `serve` binds a free loopback port, mints a per-daemon bearer token,
and writes the `.agents/runtime.json` handshake a second `bpmn` invocation reads;
`status`/`open`/`stop` are that second invocation. `--reload` is the one path that still
runs the old way (a bare `uvicorn.run` on an import string) -- reload mode re-execs via
that string in a subprocess uvicorn manages itself, which a pre-bound socket and an
in-process app object can't participate in, and it's a foreground dev loop anyway, not the
daemon this phase is otherwise building.

Phase 4: `run`/`ls`/`show`/`cancel`/`logs` are also a second `bpmn` invocation -- they
read the same `.agents/runtime.json` and speak HTTP to the daemon via `bpmn_agent.client`,
rather than touching the store or the workspace directly, so they only ever see what the
running daemon would show a web client and can never race it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import webbrowser
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import uvicorn

from bpmn_agent.agents_root import Workspace
from bpmn_agent.client import DaemonClient, DaemonNotRunningError, DaemonRequestError
from bpmn_agent.daemon import (
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
        uvicorn.run("bpmn_agent.api.server:app", host=host, port=port or 8000, reload=True)
        return

    workspace = Workspace.discover(workspace_root)
    workspace.ensure()

    existing = read_runtime_file(workspace)
    if existing is not None:
        if is_daemon_alive(existing):
            print(f"Already running at {existing.url}")
            return
        remove_runtime_file(workspace)

    # Must land before api.server's module-level `configure_logging()` call reads it, and
    # inside `.agents/logs/` rather than logging_config.py's own CWD-relative default --
    # a genuine `bpmn serve` is launched from workspace.root, and a log file written
    # directly there would sit in the git-tracked tree forever, permanently failing
    # `bpmn merge`'s clean-working-tree precondition (see workspace_strategy.py's
    # WorktreeStrategy.merge). setdefault, not assignment: an operator's own LOG_FILE wins.
    os.environ.setdefault("LOG_FILE", str(workspace.logs_dir / "bpmn-agent.log"))

    # Imported here, not at module level: init/status/open/stop never need FastAPI, all the
    # routers, and the rest of the app-construction machinery loaded at all.
    from bpmn_agent.api.server import create_app

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
    print(f"bpmn agent · {workspace.root.name} · {url}")

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
        print(f"Stale runtime info for {workspace.root} -- run `bpmn serve` to start fresh")
        return
    print(f"bpmn agent · {workspace.root.name} · {info.url}")


def _cmd_open(workspace_root: Path | None) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `bpmn serve` first.")
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


def _run_daemon_command(workspace_root: Path | None, action: Callable[[DaemonClient], Awaitable[None]]) -> None:
    """Discover the workspace, connect to its running daemon, and run `action` against it --
    the common shell every run/ls/show/cancel/logs verb below wraps its own logic in.
    Both "no daemon running" and an error response from a live one are user mistakes, not
    bugs, so they print a plain message and exit(1) rather than a traceback.
    """
    workspace = Workspace.discover(workspace_root)

    async def go() -> None:
        try:
            client = DaemonClient.for_workspace(workspace)
        except DaemonNotRunningError as exc:
            raise SystemExit(str(exc)) from exc
        try:
            async with client:
                await action(client)
        except DaemonRequestError as exc:
            raise SystemExit(f"Error: {exc.detail}") from exc

    asyncio.run(go())


def _parse_variables(pairs: list[str]) -> dict[str, Any]:
    """Parse repeated `--var KEY=VALUE` flags into a variables dict. Each value is tried as
    JSON first (so `--var count=3` and `--var enabled=true` come through typed) and falls
    back to a plain string when it doesn't parse as JSON (so `--var name=Alice` just works).
    """
    variables: dict[str, Any] = {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"Invalid --var {pair!r}: expected KEY=VALUE")
        key, _, raw_value = pair.partition("=")
        try:
            value: Any = json.loads(raw_value)
        except ValueError:
            value = raw_value
        variables[key] = value
    return variables


def _cmd_run(workspace_root: Path | None, bpmn_path: str, process_id: str | None, var_pairs: list[str]) -> None:
    variables = _parse_variables(var_pairs)

    async def action(client: DaemonClient) -> None:
        state = await client.start(bpmn_path, process_id, variables)
        print(f"Started {state['workflow_id']} ({state['status']})")

    _run_daemon_command(workspace_root, action)


def _cmd_ls(
    workspace_root: Path | None,
    status: str | None,
    limit: int | None,
    offset: int,
    since: str | None,
    until: str | None,
) -> None:
    async def action(client: DaemonClient) -> None:
        instances = await client.list_instances(status=status, limit=limit, offset=offset, since=since, until=until)
        if not instances:
            print("No instances.")
            return
        print(f"{'WORKFLOW ID':<38} {'STATUS':<12} {'PROCESS':<24} UPDATED")
        for item in instances:
            print(
                f"{item['workflow_id']:<38} {item['status']:<12} {item.get('process_id', ''):<24} "
                f"{item.get('updated_at') or ''}"
            )

    _run_daemon_command(workspace_root, action)


def _cmd_show(workspace_root: Path | None, workflow_id: str, as_json: bool) -> None:
    async def action(client: DaemonClient) -> None:
        state = await client.state(workflow_id)
        if as_json:
            print(json.dumps(state, indent=2))
            return
        print(f"{state['workflow_id']}  {state['status']}  {state['process_id']}")
        if state.get("failure_reason"):
            print(f"  failure: {state['failure_reason']}")
        for task in state.get("tasks", []):
            print(f"  task {task.get('id', '?')}: {task.get('state', '?')} ({task.get('name', '')})")

    _run_daemon_command(workspace_root, action)


def _cmd_cancel(workspace_root: Path | None, workflow_id: str) -> None:
    async def action(client: DaemonClient) -> None:
        state = await client.cancel(workflow_id)
        print(f"{state['workflow_id']}: {state['status']}")

    _run_daemon_command(workspace_root, action)


def _cmd_merge(workspace_root: Path | None, workflow_id: str) -> None:
    async def action(client: DaemonClient) -> None:
        state = await client.merge(workflow_id)
        merge_state = state.get("merge_state")
        if merge_state == "merged":
            print(f"Merged {workflow_id} -> {state.get('merge_commit')}")
        elif merge_state == "merge_deferred":
            print(f"Merge deferred: {state.get('merge_deferred_reason')}")
        else:
            print(f"{workflow_id}: merge_state={merge_state}")

    _run_daemon_command(workspace_root, action)


def _format_log_event(event: dict[str, Any]) -> str:
    task = event.get("task_name") or event.get("task_id") or "-"
    data = event.get("data") or {}
    suffix = f" {data}" if data else ""
    return f"{event.get('timestamp', '')}  {event.get('event_type', ''):<20} {task}{suffix}"


def _cmd_logs(workspace_root: Path | None, workflow_id: str, follow: bool) -> None:
    async def action(client: DaemonClient) -> None:
        if not follow:
            state = await client.state(workflow_id)
            for event in state.get("events") or []:
                print(_format_log_event(event))
            return
        seen = 0
        async for state in client.stream_events(workflow_id):
            events = state.get("events") or []
            for event in events[seen:]:
                print(_format_log_event(event))
            seen = len(events)

    _run_daemon_command(workspace_root, action)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bpmn", description="Run and manage the BPMN agent.")
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

    p_run = sub.add_parser("run", help="Start a new workflow instance against the running daemon")
    add_workspace_flag(p_run)
    p_run.add_argument("bpmn_path", help="Path to the BPMN file (as the daemon resolves it)")
    p_run.add_argument("--process-id", default=None, help="BPMN process ID (auto-detected if omitted)")
    p_run.add_argument(
        "--var", action="append", default=[], metavar="KEY=VALUE", dest="var_pairs", help="Initial workflow variable, repeatable"
    )

    p_ls = sub.add_parser("ls", help="List workflow instances known to the running daemon")
    add_workspace_flag(p_ls)
    p_ls.add_argument("--status", default=None, help="Filter by status")
    p_ls.add_argument("--limit", type=int, default=None)
    p_ls.add_argument("--offset", type=int, default=0)
    p_ls.add_argument("--since", default=None, help="ISO timestamp lower bound")
    p_ls.add_argument("--until", default=None, help="ISO timestamp upper bound")

    p_show = sub.add_parser("show", help="Show a workflow instance's state")
    add_workspace_flag(p_show)
    p_show.add_argument("workflow_id")
    p_show.add_argument("--json", action="store_true", dest="as_json", help="Print the raw JSON state")

    p_cancel = sub.add_parser("cancel", help="Cancel a running workflow instance")
    add_workspace_flag(p_cancel)
    p_cancel.add_argument("workflow_id")

    p_logs = sub.add_parser("logs", help="Show a workflow instance's event log")
    add_workspace_flag(p_logs)
    p_logs.add_argument("workflow_id")
    p_logs.add_argument("-f", "--follow", action="store_true", help="Follow new events as they arrive")

    p_merge = sub.add_parser("merge", help="Merge a completed worktree run's branch into the workspace's checked-out branch")
    add_workspace_flag(p_merge)
    p_merge.add_argument("workflow_id")

    return parser


def main(argv: list[str] | None = None) -> None:
    args = _build_parser().parse_args(argv)

    if args.command == "init":
        _cmd_init(args.workspace)
    elif args.command == "status":
        _cmd_status(args.workspace)
    elif args.command == "open":
        _cmd_open(args.workspace)
    elif args.command == "stop":
        _cmd_stop(args.workspace)
    elif args.command == "run":
        _cmd_run(args.workspace, args.bpmn_path, args.process_id, args.var_pairs)
    elif args.command == "ls":
        _cmd_ls(args.workspace, args.status, args.limit, args.offset, args.since, args.until)
    elif args.command == "show":
        _cmd_show(args.workspace, args.workflow_id, args.as_json)
    elif args.command == "cancel":
        _cmd_cancel(args.workspace, args.workflow_id)
    elif args.command == "logs":
        _cmd_logs(args.workspace, args.workflow_id, args.follow)
    elif args.command == "merge":
        _cmd_merge(args.workspace, args.workflow_id)
    elif args.command in (None, "serve"):
        workspace_root = getattr(args, "workspace", None)
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 0)
        reload = getattr(args, "reload", False)
        _cmd_serve(workspace_root, host, port, reload)


if __name__ == "__main__":
    main()
