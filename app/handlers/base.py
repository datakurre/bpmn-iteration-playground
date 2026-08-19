from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseTaskHandler(ABC):
    """Abstract base class for BPMN task type execution handlers."""

    @abstractmethod
    async def handle_task(self, workflow_id: str, task: Any, workflow: Any) -> Any:
        """Handle execution of a specific BPMN task instance."""
        ...

    @property
    @abstractmethod
    def task_type(self) -> str:
        """Return the task type name this handler processes (e.g. 'ServiceTask', 'ScriptTask')."""
        ...
