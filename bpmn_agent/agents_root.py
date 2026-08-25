"""The `.agents/` state root a `bpmn` invocation runs against.

Named apart from `bpmn_agent/workspace.py` deliberately: that module is the per-instance
*ephemeral* scratch directory a single agent turn unpacks into (tar.zst pack/unpack, one
per turn, torn down after). This module is the *project-level* root -- one per `bpmn`
invocation, holding `.agents/` and everything under it. Different lifetimes, different
concept, hence a different name rather than overloading "workspace" for both.

Phase 1 of the meta-agent refactor (docs/meta-agent-refactor-plan.md): a workspace root is
*where you ran the command*, discovered fresh each invocation, never configured. This
module only owns root discovery and the directory layout; ZODB storage, workflow
materialisation, and the free-port daemon (later in this phase and the next) build on top
of it rather than duplicating path logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

AGENTS_DIRNAME = ".agents"

# Everything under .agents/ is machine state except config.toml and workflows/, which are
# meant to be committed -- a workspace's graphs and settings are part of the project, the
# ZODB store and the live daemon's runtime.json are not.
_AGENTS_GITIGNORE = """\
# Machine state, regenerated locally. config.toml and workflows/ are committed -- see
# docs/meta-agent-refactor-plan.md.
state/
runtime.json
worktrees/
runs/
logs/
"""


@dataclass(frozen=True)
class Workspace:
    """A discovered workspace root plus its `.agents/` directory layout.

    `is_git` records whether `root` is a git checkout -- phase 3's WorkspaceStrategy
    selects worktree vs. in-place execution on it. Nothing here decides that; this class
    only answers "where" and "what does that look like on disk".
    """

    root: Path
    is_git: bool

    @classmethod
    def discover(cls, start: Path | None = None) -> Workspace:
        """Walk up from `start` (default CWD) for an existing `.agents/`, then for a
        `.git/`, else fall back to `start` itself.

        An already-initialised `.agents/` always wins over a `.git/` found closer to the
        walk's start or further up: a workspace keeps its root even if a parent directory
        also happens to be a git checkout.
        """
        here = (start or Path.cwd()).resolve()
        chain = [here, *here.parents]
        for candidate in chain:
            if (candidate / AGENTS_DIRNAME).is_dir():
                return cls(root=candidate, is_git=(candidate / ".git").exists())
        for candidate in chain:
            if (candidate / ".git").exists():
                return cls(root=candidate, is_git=True)
        return cls(root=here, is_git=False)

    @property
    def agents_dir(self) -> Path:
        return self.root / AGENTS_DIRNAME

    @property
    def state_dir(self) -> Path:
        return self.agents_dir / "state"

    @property
    def workflows_dir(self) -> Path:
        return self.agents_dir / "workflows"

    @property
    def worktrees_dir(self) -> Path:
        return self.agents_dir / "worktrees"

    @property
    def runs_dir(self) -> Path:
        return self.agents_dir / "runs"

    @property
    def logs_dir(self) -> Path:
        return self.agents_dir / "logs"

    @property
    def runtime_file(self) -> Path:
        return self.agents_dir / "runtime.json"

    @property
    def config_file(self) -> Path:
        return self.agents_dir / "config.toml"

    def ensure(self) -> None:
        """Create the `.agents/` layout this workspace needs to run. Idempotent.

        `worktrees/` and `runs/` are created on demand per run (phases 3-4), not here --
        a freshly initialised workspace with no runs yet shouldn't have empty directories
        for work that hasn't happened.
        """
        for directory in (self.agents_dir, self.state_dir, self.workflows_dir, self.logs_dir):
            directory.mkdir(parents=True, exist_ok=True)
        gitignore = self.agents_dir / ".gitignore"
        if not gitignore.is_file():
            gitignore.write_text(_AGENTS_GITIGNORE)
