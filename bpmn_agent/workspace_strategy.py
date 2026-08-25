"""Per-run workspace execution strategies: where an agent turn's files actually live.

Phase 3 of the meta-agent refactor (docs/meta-agent-refactor-plan.md) -- the crux phase.
"Run against the real checkout", "savepoints carry a workspace copy", and "several graphs
at once" cannot all hold under one model, so this is an interface with three
implementations rather than one hardcoded behaviour:

- `BlobStrategy` -- today's behaviour (an ephemeral scratch dir per turn, packed into a
  ZODB blob between turns), kept byte-for-byte. The default for every caller that hasn't
  opted into worktree/in-place execution, and the only correct choice for a template that
  genuinely wants an empty directory to scaffold into (`beamer_slides.bpmn`).
- `WorktreeStrategy` -- a real `git worktree` per run off the workspace's HEAD. A
  savepoint is a commit on the run's own branch, so fork becomes "a new worktree at that
  commit" rather than a blob copy.
- `InPlaceStrategy` -- the launch directory itself, serialised by a mutex so concurrent
  turns don't collide. No workspace snapshot is possible (`supports_snapshot = False`);
  savepoints still record graph state, just not a copy of the files.

`run_id` below is `workflow_id` throughout this codebase's current data model -- one
workspace per instance, not yet per-branch-within-an-instance. Naming it `run_id` here
matches the plan's own vocabulary, which phase 4 ("parallel long-running runs") is
expected to formalise into a distinct concept.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from ZODB.blob import Blob

from bpmn_agent.workspace import (
    WORKSPACE_OP_TIMEOUT_SECONDS,
    cleanup_workspace,
    pack_workspace_to_bytes,
    unpack_workspace,
)

if TYPE_CHECKING:
    from bpmn_agent.agents_root import Workspace
    from bpmn_agent.persistence import WorkflowStore

logger = logging.getLogger("bpmn.workspace_strategy")

GIT_OP_TIMEOUT_SECONDS = 30.0

_SEED_IGNORE = shutil.ignore_patterns(
    ".git", "node_modules", ".venv", ".devenv", ".direnv", "data", "vendor",
    "__pycache__", ".mypy_cache", ".pytest_cache", "site", "result", "*.log",
)


def _seed_workspace(workdir: str) -> None:
    """Seed a fresh BlobStrategy scratch directory from PI_WORKDIR.

    PI_WORKDIR is a template copied in once per instance, never the directory the agent
    runs in. Only meaningful for BlobStrategy's ephemeral, otherwise-empty directories --
    a worktree or in-place directory is never "empty" in this sense, it's a real
    checkout, so neither of those strategies calls this.
    """
    seed = os.getenv("PI_WORKDIR")
    if not seed:
        return
    seed_path = Path(seed).resolve()
    if not seed_path.is_dir():
        logger.warning("PI_WORKDIR=%s is not a directory; starting from an empty workspace", seed)
        return
    shutil.copytree(seed_path, workdir, dirs_exist_ok=True, ignore=_SEED_IGNORE, symlinks=True)
    logger.info("Seeded workspace from PI_WORKDIR=%s", seed_path)


class WorkspaceSnapshotUnsupportedError(Exception):
    """Raised by `fork.py` when the source savepoint's strategy has `supports_snapshot =
    False` (InPlaceStrategy) -- there is no workspace copy to restore, so a fork attempt
    is rejected before it can silently hand the new instance an empty workspace. The API
    layer (instance.py) catches this and returns a typed 409 rather than a bare string,
    so a client can branch on `mode` instead of parsing prose.
    """

    def __init__(self, mode: str) -> None:
        self.mode = mode
        super().__init__(
            f"workspace_mode={mode!r} does not support savepoint restore -- fork is unavailable for this run"
        )


class WorkspaceStrategy(Protocol):
    """Owns where one run's files live, and how a durable checkpoint of them is taken.

    `supports_snapshot` drives fork UX everywhere a caller needs to know ahead of time
    whether `snapshot`/`restore` do anything real, rather than calling `snapshot` and
    inspecting whether it returned None.

    `snapshot`'s return value and `restore`'s `ref` parameter are strategy-specific and
    opaque to callers -- a `ZODB.blob.Blob` for `BlobStrategy`, a git commit SHA (`str`)
    for `WorktreeStrategy` -- the same way a savepoint's `workspace_blob` already flows
    untouched from `savepoints.py` through to `fork.py` today.
    """

    supports_snapshot: bool

    async def acquire(self, run_id: str) -> Path:
        """A directory this run's turn may read and write. May block (in-place mode)."""
        ...

    async def release(self, run_id: str, *, persist: bool = True) -> None:
        """The turn is done with the directory `acquire` returned for `run_id`.

        `persist=False` means the turn crashed before it could complete cleanly (an
        exception, not just an agent-reported failure) -- discard whatever changes are
        sitting in the directory rather than committing them. Only `BlobStrategy` acts on
        this: worktree and in-place directories are always live, so there is nothing a
        crash needs "not persisted" out of.
        """
        ...

    async def snapshot(self, run_id: str, label: str) -> Any | None:
        """Durably checkpoint the run's current files. None if unsupported."""
        ...

    async def restore(self, ref: Any, into_run: str) -> Path:
        """Materialise a snapshot's files for a new run (fork)."""
        ...

    async def discard(self, run_id: str) -> None:
        """The run's lifecycle has ended; release anything `acquire` allocated for good."""
        ...


class BlobStrategy:
    """Today's behaviour, unchanged: unpack the ZODB blob into a scratch dir per turn,
    pack it back with an optimistic-concurrency version check on release.
    """

    supports_snapshot = True

    def __init__(self, store: WorkflowStore) -> None:
        self.store = store
        self._workdirs: dict[str, str] = {}
        self._versions: dict[str, int] = {}

    async def acquire(self, run_id: str) -> Path:
        blob_or_bytes = self.store.get_workspace(run_id)
        self._versions[run_id] = self.store.get_workspace_version(run_id)
        workdir = await unpack_workspace(blob_or_bytes, prefix=f"bpmn-{run_id[:8]}-")
        if not blob_or_bytes:
            await asyncio.wait_for(asyncio.to_thread(_seed_workspace, workdir), timeout=WORKSPACE_OP_TIMEOUT_SECONDS)
        self._workdirs[run_id] = workdir
        return Path(workdir)

    async def release(self, run_id: str, *, persist: bool = True) -> None:
        workdir = self._workdirs.pop(run_id, None)
        expected_version = self._versions.pop(run_id, None)
        try:
            if persist and workdir and Path(workdir).exists():
                archive_bytes = await pack_workspace_to_bytes(workdir)
                self.store.set_workspace(run_id, archive_bytes, expected_version=expected_version)
        finally:
            if workdir:
                cleanup_workspace(workdir)

    async def snapshot(self, run_id: str, label: str) -> Blob | None:
        blob_or_bytes = self.store.get_workspace(run_id)
        if not blob_or_bytes:
            return None
        blob = Blob()
        with blob.open("w") as f:
            if isinstance(blob_or_bytes, bytes):
                f.write(blob_or_bytes)
            else:
                with blob_or_bytes.open("r") as src:
                    f.write(src.read())
        return blob

    async def restore(self, ref: Any, into_run: str) -> Path:
        workdir = await unpack_workspace(ref, prefix=f"bpmn-{into_run[:8]}-")
        self._workdirs[into_run] = workdir
        self._versions[into_run] = 0
        return Path(workdir)

    async def discard(self, run_id: str) -> None:
        workdir = self._workdirs.pop(run_id, None)
        self._versions.pop(run_id, None)
        if workdir:
            cleanup_workspace(workdir)


async def _run_git(*args: str, cwd: Path) -> subprocess.CompletedProcess[bytes]:
    """Run `git` via the synchronous subprocess module in a worker thread.

    Same reasoning as `bpmn_agent.workspace._run_tar`: not `asyncio.create_subprocess_exec`,
    which registers the child with asyncio's event-loop-bound child watcher and corrupts
    that watcher's process-global state under many short-lived event loops each spawning a
    subprocess this way. `subprocess.run()` reaps synchronously via `os.waitpid()` on the
    one worker thread it runs in, never touching that machinery.
    """

    def _run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, timeout=GIT_OP_TIMEOUT_SECONDS, check=False
        )

    return await asyncio.to_thread(_run)


class GitOperationError(RuntimeError):
    """A `git` subprocess this strategy ran exited non-zero."""


async def _git(*args: str, cwd: Path) -> str:
    proc = await _run_git(*args, cwd=cwd)
    if proc.returncode != 0:
        raise GitOperationError(f"git {' '.join(args)!r} failed in {cwd}: {proc.stderr.decode(errors='replace')}")
    return proc.stdout.decode(errors="replace").strip()


class WorktreeStrategy:
    """A real `git worktree` per run, off the workspace's own HEAD.

    Each run gets an isolated checkout of the real project on its own branch
    (`bpmn/run/<run-id>`). A savepoint is a commit on that branch, so `restore` -- a fork
    -- is a new worktree at that commit on its own new branch: fork becomes a branch,
    which is what it always wanted to be. Merging a finished run's branch back is a
    separate, explicit operation (docs/meta-agent-refactor-plan.md §6), not something this
    strategy does on its own.
    """

    supports_snapshot = True

    def __init__(self, workspace: Workspace) -> None:
        self.workspace = workspace

    def _branch_name(self, run_id: str) -> str:
        return f"bpmn/run/{run_id}"

    def _worktree_path(self, run_id: str) -> Path:
        return self.workspace.worktrees_dir / run_id

    async def acquire(self, run_id: str) -> Path:
        path = self._worktree_path(run_id)
        if path.is_dir():
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        branch = self._branch_name(run_id)
        branch_exists = (
            await _run_git("rev-parse", "--verify", "--quiet", branch, cwd=self.workspace.root)
        ).returncode == 0
        if branch_exists:
            await _git("worktree", "add", str(path), branch, cwd=self.workspace.root)
        else:
            await _git("worktree", "add", "-b", branch, str(path), "HEAD", cwd=self.workspace.root)
        return path

    async def release(self, run_id: str, *, persist: bool = True) -> None:
        # The worktree is the live directory -- an agent turn already wrote directly to
        # it, so there is nothing to pack back the way BlobStrategy does, and nothing a
        # crash needs undone: uncommitted changes just stay uncommitted (`persist` is a
        # BlobStrategy-only concern). A durable checkpoint is an explicit `snapshot()`
        # call (a commit), not an implicit one on every turn's release.
        pass

    async def snapshot(self, run_id: str, label: str) -> str | None:
        path = self._worktree_path(run_id)
        if not path.is_dir():
            return None
        await _git("add", "-A", cwd=path)
        await _git("commit", "--allow-empty", "-m", label, cwd=path)
        return await _git("rev-parse", "HEAD", cwd=path)

    async def restore(self, ref: Any, into_run: str) -> Path:
        path = self._worktree_path(into_run)
        if path.is_dir():
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        branch = self._branch_name(into_run)
        await _git("worktree", "add", "-b", branch, str(path), str(ref), cwd=self.workspace.root)
        return path

    async def discard(self, run_id: str) -> None:
        """Remove the run's worktree. The branch itself is left alone -- a finished run
        leaves a branch for the user to review or merge (§6), not something this deletes.
        """
        path = self._worktree_path(run_id)
        if not path.exists():
            return
        with contextlib.suppress(GitOperationError):
            await _git("worktree", "remove", "--force", str(path), cwd=self.workspace.root)


# One lock per workspace root, not one per strategy instance -- a strategy may be
# constructed fresh per turn dispatch, but the mutex must be the same object across every
# turn against the same workspace or it serialises nothing.
_IN_PLACE_LOCKS: dict[str, asyncio.Lock] = {}


class InPlaceStrategy:
    """The launch directory itself -- automatic in a non-git workspace, or `--in-place`.

    First-class, not a fallback: it is the only strategy that can run in a directory with
    no `.git/` at all, so it must work well rather than merely exist. A per-workspace-root
    mutex serialises *turns*: several graphs can still park, think, and wait on humans
    concurrently, but only one harness holds the tree at a time -- "parallel runs" here
    means parallel waiting, serialised working, and every surface that shows a run's state
    should say so plainly.

    `supports_snapshot` is `False`: no workspace copy is possible, so savepoints under
    this strategy record graph state only (retry, resume, and history all keep working;
    only the file-level checkpoint is missing), and a fork attempt must be rejected before
    it ever reaches `restore` -- see fork.py and the API's typed 409.
    """

    supports_snapshot = False

    def __init__(self, workspace: Workspace) -> None:
        self.workspace = workspace
        self._lock = _IN_PLACE_LOCKS.setdefault(str(workspace.root), asyncio.Lock())

    async def acquire(self, run_id: str) -> Path:
        await self._lock.acquire()
        return self.workspace.root

    async def release(self, run_id: str, *, persist: bool = True) -> None:
        if self._lock.locked():
            self._lock.release()

    async def snapshot(self, run_id: str, label: str) -> None:
        return None

    async def restore(self, ref: Any, into_run: str) -> Path:
        raise NotImplementedError(
            "InPlaceStrategy does not support workspace restore -- check supports_snapshot "
            "before calling restore(); fork is rejected upstream of this call."
        )

    async def discard(self, run_id: str) -> None:
        # No per-run resource to release beyond the turn mutex, which release() already
        # owns -- nothing left to clean up here.
        pass


_VALID_MODES = frozenset({"blob", "worktree", "in_place"})


def select_strategy(
    workspace: Workspace | None,
    store: WorkflowStore,
    config: dict[str, str],
    workflow_data: dict[str, Any],
) -> WorkspaceStrategy:
    """Choose a run's `WorkspaceStrategy`.

    Selection order: an explicit `workspace_mode` `camunda:property` on the task, then a
    workflow-wide `workspace_mode` in `workflow.data` (settable as a start variable --
    there is no process-level `camunda:properties` reader yet, so this is the practical
    stand-in for "declared once for the whole graph"), then -- only when a real `Workspace`
    was communicated to this service -- worktree if that workspace is a git checkout, else
    in-place.

    A `WorkflowService` built with no workspace (library usage, and every test in this
    suite that hasn't opted in) always gets `BlobStrategy`: nothing here is allowed to
    guess a workspace root nobody told it about, since `Workspace.discover()` would happily
    find *some* git checkout at the current working directory and that would silently
    change what a plain `WorkflowService(store)` does depending on where it happens to run
    from -- exactly the ambiguity a workspace has to be explicit to avoid.
    """
    mode = config.get("workspace_mode") or workflow_data.get("workspace_mode")
    if mode is not None and mode not in _VALID_MODES:
        raise ValueError(f"unknown workspace_mode {mode!r} (expected one of {sorted(_VALID_MODES)})")

    if mode == "blob" or (mode is None and workspace is None):
        return BlobStrategy(store)
    if workspace is None:
        raise ValueError(f"workspace_mode={mode!r} requires a workspace-backed WorkflowService")
    if mode == "worktree" or (mode is None and workspace.is_git):
        return WorktreeStrategy(workspace)
    return InPlaceStrategy(workspace)
