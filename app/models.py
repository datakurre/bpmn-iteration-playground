from typing import Any
from pydantic import BaseModel, Field


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


class WebhookRegistration(BaseModel):
    url: str = Field(
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
