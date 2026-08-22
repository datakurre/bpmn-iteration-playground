import json
from typing import Any

from pydantic import BaseModel, Field, HttpUrl, field_validator

MAX_VARIABLES_SIZE_BYTES = 1024 * 1024  # 1 MB
MAX_VARIABLES_DEPTH = 10


def _check_variable_depth(v: Any, current_depth: int = 1) -> None:
    if current_depth > MAX_VARIABLES_DEPTH:
        raise ValueError(f"Variables depth exceeds maximum allowed depth of {MAX_VARIABLES_DEPTH}")
    if isinstance(v, dict):
        for val in v.values():
            _check_variable_depth(val, current_depth + 1)
    elif isinstance(v, (list, tuple)):
        for item in v:
            _check_variable_depth(item, current_depth + 1)


def _validate_variables(v: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise ValueError("Variables must be a dictionary")
    _check_variable_depth(v)
    try:
        serialized = json.dumps(v)
        if len(serialized.encode("utf-8")) > MAX_VARIABLES_SIZE_BYTES:
            raise ValueError(f"Variables payload exceeds maximum size of {MAX_VARIABLES_SIZE_BYTES} bytes")
    except (TypeError, OverflowError) as exc:
        raise ValueError(f"Variables must be JSON serializable: {exc}") from exc
    return v


class StartWorkflowRequest(BaseModel):
    bpmn_path: str = Field(
        default="workflows/contract_review.bpmn",
        description="Path to the BPMN file to execute",
        json_schema_extra={"example": "workflows/contract_review.bpmn"},
    )
    process_id: str | None = Field(
        default=None,
        description="BPMN process ID (auto-detected if omitted)",
    )
    variables: dict[str, Any] = Field(
        default_factory=dict,
        description="Initial workflow variables",
        json_schema_extra={"example": {"contract": "Review this agreement for compliance."}},
    )

    @field_validator("variables")
    @classmethod
    def validate_vars(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _validate_variables(v)


class MessageRequest(BaseModel):
    payload: dict[str, Any] = Field(
        default_factory=dict,
        description="Message payload merged into the catching task's data",
        json_schema_extra={"example": {"approved_by": "ops-team"}},
    )


class SubmitTaskRequest(BaseModel):
    task_id: str | None = Field(
        default=None,
        description="Task ID to complete (optional if in URL path)",
    )
    variables: dict[str, Any] = Field(
        default_factory=dict,
        description="Form output variables to merge into workflow",
        json_schema_extra={"example": {"decision": "approved", "notes": "Looks good."}},
    )

    @field_validator("variables")
    @classmethod
    def validate_vars(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _validate_variables(v)


class AdminCleanupRequest(BaseModel):
    confirm: str = Field(
        description="Confirmation string (must be DELETE_ALL)",
        json_schema_extra={"example": "DELETE_ALL"},
    )


class ForkRequest(BaseModel):
    variables: dict[str, Any] = Field(
        default_factory=dict,
        description="Optional variable overrides for the forked branch",
    )

    @field_validator("variables")
    @classmethod
    def validate_vars(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _validate_variables(v)


class PurgeSavePointsRequest(BaseModel):
    before: str | None = Field(
        default=None,
        description="ISO-8601 timestamp anchor; savepoints created strictly before this are purged. The anchor itself is not required to exist as a savepoint.",
        json_schema_extra={"example": "2026-08-21T00:00:00+00:00"},
    )
    before_task_id: str | None = Field(
        default=None,
        description="Element anchor: purge every savepoint older than this task's newest savepoint. That savepoint is kept.",
    )


class PurgeSavePointsResponse(BaseModel):
    purged: int
    remaining: int


class WebhookRegistration(BaseModel):
    url: HttpUrl = Field(
        description="HTTP webhook target URL",
        json_schema_extra={"example": "https://example.com/webhook"},
    )
    events: list[str] | None = Field(
        default=None,
        description="Optional list of event types to subscribe to (null for all)",
        json_schema_extra={"example": ["workflow_completed", "pi_failed"]},
    )


class TaskSnapshot(BaseModel):
    id: str
    bpmn_id: str
    name: str
    state: str
    type: str | None = None


class SavePointSummary(BaseModel):
    id: str
    phase: str
    resume_action: str
    task_id: str
    task_name: str
    created_at: str


class WorkflowState(BaseModel):
    workflow_id: str
    status: str
    process_id: str
    bpmn_path: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    tasks: list[dict[str, Any]] = Field(default_factory=list)
    jobs: dict[str, Any] = Field(default_factory=dict)
    failure_reason: str | None = None
    save_points: list[dict[str, Any]] = Field(default_factory=list)
    events: list[dict[str, Any]] | None = None
    created_at: str | None = None
    updated_at: str | None = None
    parent_workflow_id: str | None = None
    forked_from: str | None = None
    forked_from_save_point: str | None = None
    workspace_metadata: dict[str, Any] | None = None


class WorkflowResponse(BaseModel):
    workflow_id: str
    status: str
    state: dict[str, Any]


class StorageStats(BaseModel):
    storage_type: str
    path: str
    size_bytes: int
    size_human: str
    instances_count: int
    save_points_count: int


class PackResult(BaseModel):
    path: str
    size_before_bytes: int
    size_after_bytes: int
    reclaimed_bytes: int
    size_before_human: str
    size_after_human: str
    reclaimed_human: str


class HarnessSummary(BaseModel):
    """A registered harness and what it declares about itself.

    Lets a client (BPMN editor palette, instance UI) discover the available
    `harness_type` values and how to render a turn, instead of hardcoding them.
    """

    harness_type: str
    display_name: str
    supports_sessions: bool = False
    consumes_prompt: bool = True
    view: str = "agent"


class TemplateSummary(BaseModel):
    id: str
    name: str
    path: str
    description: str = ""
    category: str = "general"
    variables: list[dict[str, Any]] = Field(default_factory=list)


class SaveWorkflowResponse(BaseModel):
    path: str
    process_ids: list[str]


class WebhookResponse(BaseModel):
    id: str
    url: str
    events: list[str] | None = None
    created_at: str


class DeleteWebhookResponse(BaseModel):
    deleted: bool


class DeleteInstanceResponse(BaseModel):
    deleted: str


class ClearInstancesResponse(BaseModel):
    deleted: int

