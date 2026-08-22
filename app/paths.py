"""Shared workspace-containment check.

Used everywhere a relative path supplied by BPMN config or by agent output must be
confined inside a workspace directory -- both a security boundary (preventing an agent
or a hand-authored template from writing outside its sandbox) and a correctness one
(malformed paths must not raise).
"""

from __future__ import annotations

from pathlib import Path


def contained_path(root: str | Path, relative: str) -> Path | None:
    """Resolve `relative` under `root`, or None if it escapes (or equals) `root`.

    Rejects absolute paths, `..` escapes, and null bytes outright. A relative path that
    resolves to `root` itself is also rejected -- callers that mean "the workspace root"
    already have a way to say so (an empty/unset config value), so this stays strict
    rather than special-casing `.`.
    """
    if not relative or relative.startswith(("/", "\\")) or "\x00" in relative:
        return None
    root_resolved = Path(root).resolve()
    try:
        candidate = (root_resolved / relative).resolve()
    except (OSError, RuntimeError):
        return None
    if candidate == root_resolved or root_resolved not in candidate.parents:
        return None
    return candidate
