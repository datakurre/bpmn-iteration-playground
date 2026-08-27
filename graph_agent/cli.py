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
from graph_agent.registry import BUNDLED_MODELS_DIR, BUNDLED_WORKFLOWS_DIR


def _materialize_bundled_workflows(workspace: Workspace) -> tuple[int, int]:
    """Copy this package's bundled `*.bpmn` templates into `workspace.models_dir`.

    Never overwrites a file already there, the same convention `ShellAdapter`'s own
    `template=` scaffolding uses: a workspace's models are meant to be edited, and a
    second `bpmn init` (a version upgrade, say) must not silently discard those edits.
    Returns (copied, skipped).
    """
    copied = 0
    skipped = 0
    workspace.models_dir.mkdir(parents=True, exist_ok=True)
    source_dir = BUNDLED_MODELS_DIR if BUNDLED_MODELS_DIR.exists() else BUNDLED_WORKFLOWS_DIR
    for src in sorted(source_dir.glob("*.bpmn")):
        dst = workspace.models_dir / src.name
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
    print(f"  models/: {copied} template(s) added, {skipped} already present")
    print(f"  state:   {workspace.state_dir}")
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
    """Run the daemon in the foreground (blocking).  Used by --no-tui and --reload."""
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
    url_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    url = f"http://{url_host}:{bound_port}"

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


def _cmd_serve_with_tui(workspace_root: Path | None, host: str, port: int) -> None:
    """Start the daemon in a background process, then attach the TUI in the foreground.

    This is the default behaviour of bare ``bpmn serve`` (without ``--no-tui``).
    The daemon process writes ``.agents/runtime.json`` before the parent reads it,
    coordinated by a short poll loop (up to 10 s) so the TUI can connect immediately.
    """
    import signal
    import time

    workspace = Workspace.discover(workspace_root)
    workspace.ensure()

    existing = read_runtime_file(workspace)
    if existing is not None and is_daemon_alive(existing):
        # Daemon already running — just attach TUI.
        print(f"graph-agent · {workspace.root.name} · {existing.url}")
        from graph_agent.tui.app import launch_tui
        from graph_agent.tui.client import DaemonClient

        client = DaemonClient(base_url=existing.url, token=existing.token, workspace=workspace)
        launch_tui(client, workspace=workspace)
        return

    # Fork the daemon into the background.
    child_pid = os.fork()
    if child_pid == 0:
        # ── child: run daemon in foreground (blocking) ──────────────────────
        # Detach from the parent's terminal so signals don't propagate.
        os.setsid()
        _cmd_serve(workspace_root, host, port, reload=False)
        os._exit(0)

    # ── parent: wait for runtime.json to appear, then launch TUI ────────────
    deadline = time.monotonic() + 15.0
    info = None
    while time.monotonic() < deadline:
        info = read_runtime_file(workspace)
        if info is not None and is_daemon_alive(info):
            break
        time.sleep(0.2)

    if info is None or not is_daemon_alive(info):
        print("Error: daemon did not start within 15 s — check logs in .agents/logs/", file=__import__("sys").stderr)
        os.kill(child_pid, signal.SIGTERM)
        return

    print(f"graph-agent · {workspace.root.name} · {info.url}  (daemon pid {child_pid})")

    from graph_agent.tui.app import launch_tui
    from graph_agent.tui.client import DaemonClient

    client = DaemonClient(base_url=info.url, token=info.token, workspace=workspace)
    try:
        launch_tui(client, workspace=workspace)
    finally:
        # When the TUI exits, leave the daemon running so other CLI commands
        # (bpmn ls, bpmn show …) can still reach it.  Use `bpmn stop` to shut
        # it down explicitly.
        pass


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


def _cmd_open(
    workspace_root: Path | None,
    editor: str | None = None,
    target: str | None = None,
    dev: bool = True,
) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    path = ""
    if editor is not None:
        path = f"/editor/{editor}" if editor else "/editor"
    elif target:
        if target.startswith("/"):
            path = target
        elif target in ("editor", "modeler"):
            path = "/editor"
        elif target in ("dashboard", "runs"):
            path = "/"
        elif target in ("history", "admin"):
            path = f"/{target}"
        elif target.endswith(".bpmn"):
            path = f"/editor/{target}"
        else:
            path = f"/instance/{target}"

    query_parts: list[str] = []
    if dev:
        query_parts.append("dev=1")
    if info.token:
        query_parts.append(f"token={info.token}")
    query = f"?{'&'.join(query_parts)}" if query_parts else ""

    url = f"{info.url}{path}{query}"
    webbrowser.open(url)
    print(f"Opened {url}")


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
    for candidate_dir in (workspace.models_dir, workspace.workflows_dir, BUNDLED_MODELS_DIR, BUNDLED_WORKFLOWS_DIR):
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
    workspace_mode: str | None = None,
    timeout: int | None = None,
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
    if workspace_mode:
        variables["workspace_mode"] = workspace_mode
    if timeout is not None:
        variables["timeout"] = timeout

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


def _format_status(status: str) -> str:
    if status in ("waiting_human", "waiting_event"):
        return "⏸ resumable"
    if status in ("running", "waiting_pi", "retry_requested"):
        return "▶ running"
    if status == "failed":
        return "❌ failed"
    if status == "completed":
        return "✓ completed"
    if status == "cancelled":
        return "⏹ cancelled"
    return status


def _cmd_ls(workspace_root: Path | None, show_all: bool) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    import httpx

    endpoint = f"{info.url}/api/history/instances" if show_all else f"{info.url}/api/history/instances?status=active"
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
            st = _format_status(inst.get("status", ""))
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


def _cmd_delete(workspace_root: Path | None, run_id: str) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    import httpx

    try:
        resp = httpx.delete(
            f"{info.url}/instance/{run_id}",
            headers={"X-Admin-Token": info.token},
            timeout=30.0,
        )
        resp.raise_for_status()
        print(f"Purged run {run_id}")
    except httpx.HTTPStatusError as exc:
        print(f"Error purging run: {exc.response.text}")
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


def _cmd_diff(workspace_root: Path | None, run_id: str) -> None:
    workspace = Workspace.discover(workspace_root)
    info = read_runtime_file(workspace)
    if info is None or not is_daemon_alive(info):
        print(f"No daemon running for {workspace.root}. Run `graph-agent serve` first.")
        return
    import httpx

    try:
        resp = httpx.get(
            f"{info.url}/instance/{run_id}/diff",
            headers={"X-Admin-Token": info.token},
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        diff_text = data.get("diff", "")
        if not diff_text.strip():
            print(f"No uncommitted changes in worktree for run {run_id}.")
            return
        print(diff_text)
    except httpx.HTTPStatusError as exc:
        print(f"Error getting diff: {exc.response.text}")
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


def _apply_env_options(args: argparse.Namespace) -> None:
    if getattr(args, "model", None):
        os.environ["PI_MODEL"] = args.model
    if getattr(args, "provider", None):
        os.environ["PI_PROVIDER"] = args.provider
    if getattr(args, "executable", None):
        os.environ["PI_EXECUTABLE"] = args.executable
    if getattr(args, "timeout", None) is not None:
        os.environ["PI_TIMEOUT_SECONDS"] = str(args.timeout)
    if getattr(args, "offline", False):
        os.environ["PI_OFFLINE"] = "1"
    if getattr(args, "max_parallel_turns", None) is not None:
        os.environ["MAX_PARALLEL_TURNS"] = str(args.max_parallel_turns)
    if getattr(args, "timer_interval", None) is not None:
        os.environ["TIMER_TICK_SECONDS"] = str(args.timer_interval)
    if getattr(args, "savepoint_retention", None) is not None:
        os.environ["SAVEPOINT_ATTEMPT_RETENTION"] = str(args.savepoint_retention)
    if getattr(args, "workspace_mode", None):
        os.environ["WORKSPACE_MODE"] = args.workspace_mode
    if getattr(args, "log_level", None):
        os.environ["LOG_LEVEL"] = args.log_level.upper()
    if getattr(args, "merge_on_complete", None) is not None:
        os.environ["MERGE_ON_COMPLETE"] = "1" if args.merge_on_complete else "0"
    if getattr(args, "no_merge", False):
        os.environ["MERGE_ON_COMPLETE"] = "0"


def add_engine_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--model", type=str, default=None, help="AI agent model (e.g. gpt-5.6-luna, gpt-4o)")
    p.add_argument("--provider", type=str, default=None, help="AI agent provider (e.g. opencode-go, openai)")
    p.add_argument("--executable", type=str, default=None, help="Path to Pi executable binary")
    p.add_argument("--timeout", type=int, default=None, help="Turn execution timeout in seconds")
    p.add_argument(
        "--offline", action="store_true", default=False, help="Force offline mode using deterministic demo mock"
    )
    p.add_argument("--max-parallel-turns", type=int, default=None, help="Max concurrent active agent turns")
    p.add_argument(
        "--timer-interval", type=int, default=None, help="Background timer tick interval in seconds (0 disables)"
    )
    p.add_argument(
        "--savepoint-retention", type=int, default=None, help="Number of turn attempts retained in savepoints"
    )
    p.add_argument(
        "--workspace-mode", choices=["worktree", "in_place", "blob"], default=None, help="Workspace execution strategy"
    )
    p.add_argument("--log-level", choices=["debug", "info", "warning", "error"], default=None, help="Logging level")


def main(argv: list[str] | None = None) -> None:  # noqa: C901, PLR0915
    parser = argparse.ArgumentParser(prog="graph-agent", description="Run and manage the Graph agent.")
    add_engine_flags(parser)
    default_host = os.getenv("HOST", "127.0.0.1")
    default_port = int(os.getenv("PORT", "0"))
    parser.add_argument("--workspace", type=Path, default=None, help="Workspace root (default: discovered)")
    parser.add_argument("--host", default=default_host, help=f"Bind host (default: {default_host})")
    parser.add_argument("--port", type=int, default=default_port, help=f"Bind port (default: {default_port or '0, a free port'})")
    parser.add_argument("--no-tui", action="store_true", help="Run daemon headlessly without TUI")
    sub = parser.add_subparsers(dest="command")

    def add_workspace_flag(p: argparse.ArgumentParser) -> None:
        p.add_argument("--workspace", type=Path, default=None, help="Workspace root (default: discovered)")

    p_init = sub.add_parser("init", help="Set up .agents/ in the current (or given) workspace")
    add_workspace_flag(p_init)

    p_attach = sub.add_parser("attach", help="Attach TUI to an already running daemon")
    add_workspace_flag(p_attach)

    p_serve = sub.add_parser("serve", help="Run the web server (default when no command is given)")
    add_workspace_flag(p_serve)
    add_engine_flags(p_serve)
    p_serve.add_argument("--host", default=default_host, help=f"Bind host (default: {default_host})")
    p_serve.add_argument("--port", type=int, default=default_port, help=f"Bind port (default: {default_port or '0, a free port'})")
    p_serve.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    p_serve.add_argument(
        "--no-tui", action="store_true", help="Run daemon headlessly without TUI (foreground, blocking)"
    )

    p_status = sub.add_parser("status", help="Show the running daemon's URL, if any")
    add_workspace_flag(p_status)

    p_open = sub.add_parser("open", help="Open the running daemon in a browser")
    add_workspace_flag(p_open)
    p_open.add_argument("target", nargs="?", default=None, help="Workflow run ID, template name, or page to open")
    p_open.add_argument(
        "--editor",
        nargs="?",
        const="",
        metavar="TEMPLATE",
        help="Open the BPMN editor page instead of the dashboard (optionally with a specific template)",
    )
    p_open.add_argument("--dev", action="store_true", default=True, help="Open in development mode (default: True)")
    p_open.add_argument("--no-dev", action="store_false", dest="dev", help="Disable development mode")

    p_edit = sub.add_parser("edit", help="Open the BPMN editor in a browser (shortcut for `open --editor`)")
    add_workspace_flag(p_edit)
    p_edit.add_argument("template", nargs="?", default=None, help="BPMN template name to open directly in the editor")

    p_stop = sub.add_parser("stop", help="Stop the running daemon")
    add_workspace_flag(p_stop)

    p_run = sub.add_parser("run", help="Start a new workflow run")
    add_workspace_flag(p_run)
    add_engine_flags(p_run)
    p_run.add_argument("template", help="BPMN template name or path")
    p_run.add_argument(
        "--var", "-v", action="append", dest="vars", help="Workflow variable key=value (can be used multiple times)"
    )
    p_run.add_argument("--no-merge", action="store_true", help="Disable auto-merge on completion")

    p_ls = sub.add_parser("ls", help="List workflow runs")
    add_workspace_flag(p_ls)
    p_ls.add_argument("--all", "-a", action="store_true", help="List all runs from history (default: active only)")

    p_show = sub.add_parser("show", help="Show details of a workflow run")
    add_workspace_flag(p_show)
    p_show.add_argument("run_id", help="Workflow run ID")

    p_cancel = sub.add_parser("cancel", help="Cancel a running workflow")
    add_workspace_flag(p_cancel)
    p_cancel.add_argument("run_id", help="Workflow run ID")

    p_purge = sub.add_parser("purge", help="Delete and purge a workflow run")
    add_workspace_flag(p_purge)
    p_purge.add_argument("run_id", help="Workflow run ID")

    p_delete = sub.add_parser("delete", help="Delete and purge a workflow run (alias for purge)")
    add_workspace_flag(p_delete)
    p_delete.add_argument("run_id", help="Workflow run ID")

    p_merge = sub.add_parser("merge", help="Merge a completed workflow run branch")
    add_workspace_flag(p_merge)
    p_merge.add_argument("run_id", help="Workflow run ID")

    p_diff = sub.add_parser("diff", help="View git worktree diff of a workflow run")
    add_workspace_flag(p_diff)
    p_diff.add_argument("run_id", help="Workflow run ID")

    p_logs = sub.add_parser("logs", help="View or follow logs of a workflow run")
    add_workspace_flag(p_logs)
    p_logs.add_argument("run_id", help="Workflow run ID")
    p_logs.add_argument("-f", "--follow", action="store_true", help="Follow live event stream")

    args = parser.parse_args(argv)
    _apply_env_options(args)

    if args.command == "init":
        _cmd_init(args.workspace)
    elif args.command == "attach":
        _cmd_attach(args.workspace)
    elif args.command == "status":
        _cmd_status(args.workspace)
    elif args.command == "open":
        _cmd_open(
            args.workspace,
            editor=getattr(args, "editor", None),
            target=getattr(args, "target", None),
            dev=getattr(args, "dev", True),
        )
    elif args.command == "edit":
        _cmd_open(args.workspace, editor=getattr(args, "template", None) or "", dev=True)
    elif args.command == "stop":
        _cmd_stop(args.workspace)
    elif args.command == "run":
        _cmd_run(
            args.workspace,
            args.template,
            args.vars,
            args.no_merge,
            getattr(args, "workspace_mode", None),
            getattr(args, "timeout", None),
        )
    elif args.command == "ls":
        _cmd_ls(args.workspace, getattr(args, "all", False))
    elif args.command == "show":
        _cmd_show(args.workspace, args.run_id)
    elif args.command == "cancel":
        _cmd_cancel(args.workspace, args.run_id)
    elif args.command in ("purge", "delete"):
        _cmd_delete(args.workspace, args.run_id)
    elif args.command == "merge":
        _cmd_merge(args.workspace, args.run_id)
    elif args.command == "diff":
        _cmd_diff(args.workspace, args.run_id)
    elif args.command == "logs":
        _cmd_logs(args.workspace, args.run_id, getattr(args, "follow", False))
    elif args.command == "serve":
        workspace_root = getattr(args, "workspace", None)
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 0)
        reload = getattr(args, "reload", False)
        no_tui = getattr(args, "no_tui", False)
        if no_tui or reload:
            # --no-tui: foreground, blocking.  --reload: also foreground (dev loop).
            _cmd_serve(workspace_root, host, port, reload)
        else:
            # Default: daemon in background, TUI in foreground.
            _cmd_serve_with_tui(workspace_root, host, port)
    elif args.command is None:
        # Bare `bpmn`: if daemon already up attach TUI, otherwise start daemon + TUI.
        workspace_root = getattr(args, "workspace", None)
        host = getattr(args, "host", "127.0.0.1")
        port = getattr(args, "port", 0)
        _cmd_serve_with_tui(workspace_root, host, port)


if __name__ == "__main__":
    main()
