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
from typing import Any

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

    # Must land before api.server's module-level `configure_logging()` call reads it, and
    # inside `.agents/logs/` rather than logging_config.py's own CWD-relative default --
    # a genuine `graph-agent serve` is launched from workspace.root, and a log file written
    # directly there would sit in the git-tracked tree forever, permanently failing
    # `graph-agent merge`'s clean-working-tree precondition (see workspace_strategy.py's
    # WorktreeStrategy.merge). setdefault, not assignment: an operator's own LOG_FILE wins.
    os.environ.setdefault("LOG_FILE", str(workspace.logs_dir / "graph-agent.log"))

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


def _cmd_attach(workspace_root: Path | None) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    from graph_agent.tui.app import launch_tui
    from graph_agent.tui.client import DaemonClient

    client = DaemonClient(base_url=info.url, token=info.token, workspace=workspace)
    launch_tui(client, workspace=workspace)


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


def _resolve_template_path(workspace: Workspace, template: str) -> Path | None:
    p = Path(template)
    if p.is_file():
        return p
    for candidate_dir in (workspace.workflows_dir, BUNDLED_WORKFLOWS_DIR):
        c = candidate_dir / template
        if c.is_file():
            return c
        if not template.endswith(".bpmn"):
            c_bpmn = candidate_dir / f"{template}.bpmn"
            if c_bpmn.is_file():
                return c_bpmn
    return None


def _cmd_run(
    workspace_root: Path | None,
    template: str,
    vars_list: list[str] | None,
    no_merge: bool,
) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    template_path = _resolve_template_path(workspace, template)
    if template_path is None:
        print(f"Error: Template {template!r} not found in workspace or bundled workflows.")
        return

    import json
    variables: dict[str, Any] = {}
    for item in vars_list or []:
        if "=" in item:
            k, v = item.split("=", 1)
            try:
                variables[k] = json.loads(v)
            except (json.JSONDecodeError, ValueError):
                variables[k] = v
        else:
            variables[item] = True

    if no_merge:
        variables["merge_on_complete"] = False

    import httpx
    try:
        resp = httpx.post(
            f"{info.url}/workflow/start",
            headers={"X-Admin-Token": info.token},
            json={"bpmn_path": str(template_path), "variables": variables},
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        workflow_id = data.get("workflow_id")
        status = data.get("status", "running")
        print(f"Started run {workflow_id}")
        print(f"  Template: {template_path.name}")
        print(f"  Status:   {status}")
        print(f"  URL:      {info.url}/instance/{workflow_id}")
    except httpx.HTTPStatusError as exc:
        print(f"Error starting workflow: {exc.response.text}")
    except Exception as exc:
        print(f"Error: {exc}")


def _cmd_ls(workspace_root: Path | None, show_all: bool) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    import httpx
    endpoint = f"{info.url}/api/history/instances" if show_all else f"{info.url}/workflow/instances"
    try:
        resp = httpx.get(endpoint, headers={"X-Admin-Token": info.token}, timeout=30.0)
        resp.raise_for_status()
        instances = resp.json()
        if not instances:
            print("No runs found.")
            return
        header = f"{'RUN ID':<12} {'STATUS':<15} {'TEMPLATE':<25} {'TASKS':<8}"
        print(header)
        print("-" * len(header))
        for inst in instances:
            wid = inst.get("workflow_id", "")[:8]
            st = inst.get("status", "")
            bpmn = inst.get("bpmn_path")
            tmpl = Path(bpmn).stem if bpmn else inst.get("process_id", "")
            tasks = str(inst.get("task_count", len(inst.get("tasks", []))))
            print(f"{wid:<12} {st:<15} {tmpl:<25} {tasks:<8}")
    except httpx.HTTPStatusError as exc:
        print(f"Error listing runs: {exc.response.text}")
    except Exception as exc:
        print(f"Error: {exc}")


def _cmd_show(workspace_root: Path | None, run_id: str) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    import json

    import httpx
    try:
        resp = httpx.get(
            f"{info.url}/instance/{run_id}/state",
            headers={"X-Admin-Token": info.token},
            timeout=30.0,
        )
        resp.raise_for_status()
        state = resp.json()
        print(f"Run:         {state.get('workflow_id')}")
        print(f"Status:      {state.get('status')}")
        print(f"Process:     {state.get('process_id')}")
        print(f"BPMN Path:   {state.get('bpmn_path')}")
        if state.get("merge_status"):
            detail = state.get("merged_at") or state.get("merge_error") or ""
            print(f"Merge:       {state.get('merge_status')} ({detail})")
        if state.get("failure_reason"):
            print(f"Failure:     {state.get('failure_reason')}")
        print(f"Data:        {json.dumps(state.get('data', {}), indent=2)}")
        print(f"Tasks:       {len(state.get('tasks', []))} task(s)")
        for t in state.get("tasks", []):
            print(f"  - {t.get('name')} [{t.get('state')}] (id: {t.get('id')})")
        jobs = state.get("jobs", {})
        if jobs:
            print(f"Jobs:        {len(jobs)} turn(s)")
            for jid, j in jobs.items():
                print(f"  - {j.get('task_name', jid)}: status={j.get('status')} attempts={j.get('attempts', 1)}")
    except httpx.HTTPStatusError as exc:
        print(f"Error: {exc.response.text}")
    except Exception as exc:
        print(f"Error: {exc}")


def _cmd_cancel(workspace_root: Path | None, run_id: str) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    import httpx
    try:
        resp = httpx.post(
            f"{info.url}/instance/{run_id}/cancel",
            headers={"X-Admin-Token": info.token},
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        print(f"Cancelled run {run_id} (status: {data.get('status')})")
    except httpx.HTTPStatusError as exc:
        print(f"Error cancelling run: {exc.response.text}")
    except Exception as exc:
        print(f"Error: {exc}")


def _cmd_merge(workspace_root: Path | None, run_id: str) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    import httpx
    try:
        resp = httpx.post(
            f"{info.url}/instance/{run_id}/merge",
            headers={"X-Admin-Token": info.token},
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        st = data.get("status")
        msg = data.get("message", "")
        if st == "merged":
            print(f"Merged run {run_id}: {msg}")
        elif st == "merge_deferred":
            print(f"Merge deferred for run {run_id}: {msg}")
        else:
            print(f"Merge result ({st}): {msg}")
    except httpx.HTTPStatusError as exc:
        print(f"Error merging run: {exc.response.text}")
    except Exception as exc:
        print(f"Error: {exc}")


def _stream_logs(info_url: str, info_token: str, run_id: str) -> None:
    import json

    import httpx

    url = f"{info_url}/instance/{run_id}/events/stream"
    try:
        with httpx.stream("GET", url, headers={"X-Admin-Token": info_token}, timeout=None) as response:
            if response.status_code != 200:
                print(f"Failed to stream logs: HTTP {response.status_code}")
                return
            for line in response.iter_lines():
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str:
                        try:
                            payload = json.loads(data_str)
                            st = payload.get("status")
                            print(f"[{payload.get('workflow_id', run_id)[:8]}] status={st}")
                        except Exception:
                            print(data_str)
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"Stream error: {exc}")


def _cmd_logs(workspace_root: Path | None, run_id: str, follow: bool) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    if follow:
        _stream_logs(info.url, info.token, run_id)
        return
    import httpx
    try:
        resp = httpx.get(
            f"{info.url}/instance/{run_id}/state",
            headers={"X-Admin-Token": info.token},
            timeout=30.0,
        )
        resp.raise_for_status()
        state = resp.json()
        jobs = state.get("jobs", {})
        if not jobs:
            print(f"No job logs recorded for run {run_id}.")
        for task_id, job in jobs.items():
            print(f"=== Task: {job.get('task_name', task_id)} ({job.get('status')}) ===")
            if job.get("prompt"):
                print(f"--- Prompt ---\n{job['prompt']}")
            if job.get("text"):
                print(f"--- Output ---\n{job['text']}")
            if job.get("stderr"):
                print(f"--- Stderr ---\n{job['stderr']}")
            if job.get("failure_reason"):
                print(f"--- Failure Reason ---\n{job['failure_reason']}")
            print()
    except httpx.HTTPStatusError as exc:
        print(f"Error fetching logs: {exc.response.text}")
    except Exception as exc:
        print(f"Error: {exc}")


def main(argv: list[str] | None = None) -> None:  # noqa: C901, PLR0915
    parser = argparse.ArgumentParser(prog="graph-agent", description="Run and manage the Graph agent.")
    sub = parser.add_subparsers(dest="command")

    def add_workspace_flag(p: argparse.ArgumentParser) -> None:
        p.add_argument("--workspace", type=Path, default=None, help="Workspace root (default: discovered)")

    p_init = sub.add_parser("init", help="Set up .agents/ in the current (or given) workspace")
    add_workspace_flag(p_init)

    p_attach = sub.add_parser("attach", help="Attach TUI to an already running daemon")
    add_workspace_flag(p_attach)

    p_serve = sub.add_parser("serve", help="Run the web server (default when no command is given)")
    add_workspace_flag(p_serve)
    p_serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=0, help="Bind port (default: 0, a free port)")
    p_serve.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    p_serve.add_argument("--no-tui", action="store_true", help="Run daemon headlessly without TUI")

    p_status = sub.add_parser("status", help="Show the running daemon's URL, if any")
    add_workspace_flag(p_status)

    p_open = sub.add_parser("open", help="Open the running daemon in a browser")
    add_workspace_flag(p_open)

    p_stop = sub.add_parser("stop", help="Stop the running daemon")
    add_workspace_flag(p_stop)

    p_run = sub.add_parser("run", help="Start a new workflow run")
    add_workspace_flag(p_run)
    p_run.add_argument("template", help="BPMN template name or path")
    p_run.add_argument("--var", "-v", action="append", dest="vars", help="Workflow variable key=value (can be used multiple times)")
    p_run.add_argument("--no-merge", action="store_true", help="Disable auto-merge on completion")

    p_ls = sub.add_parser("ls", help="List workflow runs")
    add_workspace_flag(p_ls)
    p_ls.add_argument("--all", "-a", action="store_true", help="List all runs from history")

    p_show = sub.add_parser("show", help="Show details of a workflow run")
    add_workspace_flag(p_show)
    p_show.add_argument("run_id", help="Workflow run ID")

    p_cancel = sub.add_parser("cancel", help="Cancel a running workflow")
    add_workspace_flag(p_cancel)
    p_cancel.add_argument("run_id", help="Workflow run ID")

    p_merge = sub.add_parser("merge", help="Merge a completed workflow run branch")
    add_workspace_flag(p_merge)
    p_merge.add_argument("run_id", help="Workflow run ID")

    p_logs = sub.add_parser("logs", help="View or follow logs of a workflow run")
    add_workspace_flag(p_logs)
    p_logs.add_argument("run_id", help="Workflow run ID")
    p_logs.add_argument("-f", "--follow", action="store_true", help="Follow live event stream")

    args = parser.parse_args(argv)

    if args.command == "init":
        _cmd_init(args.workspace)
    elif args.command == "attach":
        _cmd_attach(args.workspace)
    elif args.command == "status":
        _cmd_status(args.workspace)
    elif args.command == "open":
        _cmd_open(args.workspace)
    elif args.command == "stop":
        _cmd_stop(args.workspace)
    elif args.command == "run":
        _cmd_run(args.workspace, args.template, args.vars, args.no_merge)
    elif args.command == "ls":
        _cmd_ls(args.workspace, getattr(args, "all", False))
    elif args.command == "show":
        _cmd_show(args.workspace, args.run_id)
    elif args.command == "cancel":
        _cmd_cancel(args.workspace, args.run_id)
    elif args.command == "merge":
        _cmd_merge(args.workspace, args.run_id)
    elif args.command == "logs":
        _cmd_logs(args.workspace, args.run_id, getattr(args, "follow", False))
    elif args.command == "serve":
        workspace_root = getattr(args, "workspace", None)
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 0)
        reload = getattr(args, "reload", False)
        _cmd_serve(workspace_root, host, port, reload)
    elif args.command is None:
        workspace_root = getattr(args, "workspace", None)
        ws = Workspace.discover(workspace_root)
        info = read_runtime_file(ws)
        if info is not None and is_daemon_alive(info):
            _cmd_attach(workspace_root)
        else:
            _cmd_serve(workspace_root, "127.0.0.1", 0, False)


if __name__ == "__main__":
    main()
