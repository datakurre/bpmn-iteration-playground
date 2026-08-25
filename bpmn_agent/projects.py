"""Projects: the long-running top-level noun, built on instances rather than beside them.

A Project is a **root instance whose process declares itself one** -- there is no Project
record and nothing but the running graph owns its lifecycle (plans/concepts.md "Project
identity is convention, not a record"). This module is therefore a projection over data
that already exists: `WorkflowRegistry` says which templates are Projects, the `metadata`
OOBTree says which instances are roots, and `workflow.data` carries the name.

Nothing here reimplements orchestration. Creating a Project is `WorkflowService.start()`
with two extra variables; spawning into one is `WorkflowService.send_message()` with the
`spawn_requested` message `workflows/project.bpmn` already catches.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from bpmn_agent.registry import WorkflowRegistry
from bpmn_agent.workflow_service import WorkflowService

logger = logging.getLogger("bpmn.projects")

SPAWN_MESSAGE = "spawn_requested"

_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")

#: Statuses that mean a Project (or child) is no longer running.
CLOSED_STATUSES = frozenset({"completed", "cancelled", "error", "failed"})


class ProjectNotFoundError(Exception):
    """No Project resolves to the given slug."""


class DuplicateProjectError(Exception):
    """A Project with this slug already exists."""


def slugify(name: str) -> str:
    """A URL-safe handle for a Project name.

    Collapses every run of non-alphanumerics to a single hyphen. Returns `""` for a name
    with nothing sluggable in it (e.g. only punctuation, or only non-Latin script) -- the
    caller must reject that rather than mint a Project that cannot be addressed.
    """
    return _SLUG_STRIP_RE.sub("-", name.strip().lower()).strip("-")


class ProjectService:
    """Read/write surface for Projects, projected over instances."""

    def __init__(self, service: WorkflowService, registry: WorkflowRegistry | None = None) -> None:
        self.service = service
        self.registry = registry or WorkflowRegistry()

    # -- discovery ---------------------------------------------------------------

    def project_process_ids(self) -> set[str]:
        """Process ids of templates that declare themselves Projects."""
        return {t.id for t in self.registry.list_templates() if t.is_project}

    def _is_project_record(self, meta: dict[str, Any], project_ids: set[str]) -> bool:
        return meta.get("parent_workflow_id") is None and meta.get("process_id") in project_ids

    def _summarize(self, meta: dict[str, Any], children: list[dict[str, Any]]) -> dict[str, Any]:
        data = meta.get("data") or {}
        workflow_id = meta["workflow_id"]
        open_children = [c for c in children if c.get("status") not in CLOSED_STATUSES]
        return {
            "workflow_id": workflow_id,
            "slug": data.get("project_slug") or workflow_id,
            "name": data.get("project_name") or workflow_id,
            "status": meta.get("status"),
            "process_id": meta.get("process_id"),
            "bpmn_path": meta.get("bpmn_path"),
            "created_at": meta.get("created_at"),
            "updated_at": meta.get("updated_at"),
            "child_count": len(children),
            "open_child_count": len(open_children),
        }

    def list_projects(self) -> list[dict[str, Any]]:
        """Every Project, newest activity first.

        One `list_metadata()` pass builds both the Project set and the child index, so this
        stays a single store read however many children the Projects have accumulated.
        """
        project_ids = self.project_process_ids()
        all_meta = self.service.store.list_metadata()

        children_by_parent: dict[str, list[dict[str, Any]]] = {}
        for meta in all_meta:
            parent = meta.get("parent_workflow_id")
            if parent:
                children_by_parent.setdefault(parent, []).append(meta)

        return [
            self._summarize(meta, children_by_parent.get(meta["workflow_id"], []))
            for meta in all_meta
            if self._is_project_record(meta, project_ids)
        ]

    def resolve(self, slug: str) -> str:
        """Root workflow id for a slug, accepting a raw workflow id as a fallback.

        Slug uniqueness is advisory, not enforced by a unique index (see the module
        docstring): a fork of a Project, or a direct store write, can produce a second
        instance carrying the same slug. Resolution is therefore deliberately
        **first-match-wins over the newest-activity ordering** rather than an error --
        addressing an ambiguous slug must not break, and `list_projects()` still shows both.
        """
        for project in self.list_projects():
            if project["slug"] == slug or project["workflow_id"] == slug:
                return str(project["workflow_id"])
        raise ProjectNotFoundError(slug)

    def children_of(self, root_workflow_id: str) -> list[dict[str, Any]]:
        """Child instances of a Project, newest activity first.

        `_sync_children` already writes every CallActivity and event-subprocess child as its
        own record with a `parent_workflow_id` back-reference, so this is a filter, not a
        walk of the workflow object.
        """
        return [
            {
                "workflow_id": meta["workflow_id"],
                "status": meta.get("status"),
                "process_id": meta.get("process_id"),
                "created_at": meta.get("created_at"),
                "updated_at": meta.get("updated_at"),
                "task_brief": (meta.get("data") or {}).get("task_brief"),
                "failure_reason": meta.get("failure_reason"),
            }
            for meta in self.service.store.list_metadata()
            if meta.get("parent_workflow_id") == root_workflow_id
        ]

    def get(self, slug: str) -> dict[str, Any]:
        """Full Project view: summary, children, and Project-scoped side-store state."""
        workflow_id = self.resolve(slug)
        meta = next(
            (m for m in self.service.store.list_metadata() if m["workflow_id"] == workflow_id),
            None,
        )
        if meta is None:  # pragma: no cover -- resolve() just found it
            raise ProjectNotFoundError(slug)
        children = self.children_of(workflow_id)
        summary = self._summarize(meta, children)
        summary["children"] = children
        summary["state"] = self.service.store.get_project_state(workflow_id)
        return summary

    # -- mutation ----------------------------------------------------------------

    async def create(self, name: str, bpmn_path: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        """Open a new Project.

        The name and slug are start variables, so they live in `workflow.data` and travel
        with a fork. Uniqueness is checked here and nowhere else -- see `resolve()` for why
        that check is advisory rather than a constraint.
        """
        slug = slugify(name)
        if not slug:
            raise ValueError("project name must contain at least one letter or digit")

        for existing in self.list_projects():
            if existing["slug"] == slug:
                raise DuplicateProjectError(slug)

        start_variables = dict(variables or {})
        start_variables.update({"project_name": name.strip(), "project_slug": slug})

        logger.info("Opening project", extra={"project_slug": slug, "bpmn_path": bpmn_path})
        state = await self.service.start(bpmn_path, variables=start_variables)
        return self.get(slug) if state else state

    async def spawn(self, slug: str, task_brief: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Spawn a child task into a Project.

        Thin wrapper over the existing message path -- `workflows/project.bpmn` catches
        `spawn_requested` in a `triggeredByEvent` subprocess, and `send_message` already
        handles copying the payload onto the spawned child's own `workflow.data`.
        """
        workflow_id = self.resolve(slug)
        message_payload = dict(payload or {})
        message_payload["task_brief"] = task_brief
        return await self.service.send_message(workflow_id, SPAWN_MESSAGE, message_payload)

    def set_state(self, slug: str, state: dict[str, Any]) -> dict[str, Any]:
        """Replace the Project's side-store state (repo map, policy, issues, log)."""
        return self.service.store.set_project_state(self.resolve(slug), state)
