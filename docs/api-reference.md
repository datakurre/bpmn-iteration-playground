# REST & WebSocket API Reference

The **graph-agent** daemon exposes REST and WebSocket endpoints on a dynamically allocated loopback port, authenticated via the local bearer token stored in `.agents/runtime.json`.

---

## Authentication & Headers

| Header | Description | Default Role |
| :--- | :--- | :--- |
| `X-Admin-Token` | Loopback bearer token from `.agents/runtime.json` or configured `ADMIN_TOKEN` | `ADMIN` |
| `X-Api-Key` | API key configured via `API_KEYS=key:role` | Role mapped from key |

---

## Workflow Endpoints

### Start Workflow Run
`POST /workflow/start`

**Request Body:**
```json
{
  "bpmn_path": "plan_and_execute.bpmn",
  "process_id": null,
  "variables": {
    "goal": "Refactor data access layer",
    "merge_on_complete": true
  }
}
```

**Response (`WorkflowState`):**
```json
{
  "workflow_id": "a1b2c3d4e5f6",
  "status": "running",
  "process_id": "plan_and_execute",
  "data": { ... },
  "tasks": [ ... ],
  "jobs": { ... },
  "save_points": [ ... ]
}
```

---

### Get Instance State
`GET /instance/{workflow_id}/state` or `GET /workflow/{workflow_id}/state`

Returns full execution state, tasks, job telemetry, variables, merge status, and savepoints.

---

### Submit Human Task
`POST /instance/{workflow_id}/submit-task/{task_id}`

**Request Body:**
```json
{
  "variables": {
    "decision": "approved",
    "notes": "Reviewed plan and approved execution."
  }
}
```

---

### Manual Merge Run
`POST /instance/{workflow_id}/merge`

Manually attempts an auto-merge of `bpmn/run/<workflow_id>` into the base branch for runs in `merge_deferred` or `completed` state.

---

### Cancel Instance
`POST /instance/{workflow_id}/cancel`

Cancels all pending background jobs and transitions the workflow status to `cancelled`.

---

### Retry Failed Task
`POST /instance/{workflow_id}/retry/{task_id}`

Re-invokes the execution harness for a failed agent or shell task from its prior checkpoint.

---

### Fork from Savepoint
`POST /instance/{workflow_id}/fork/{save_point_id}`

**Request Body:**
```json
{
  "variables": {
    "goal": "Alternative design variant"
  }
}
```

Creates a new branched instance rooted at the savepoint. In `worktree` mode, branches the Git history at the recorded commit SHA; in `blob` mode, duplicates the workspace blob. Returns `409 Conflict` under `in_place` mode where snapshots are unsupported.

---

### Purge Save Points
`DELETE /instance/{workflow_id}/savepoints`

**Request Body** (exactly one anchor):
```json
{ "before_task_id": "task_id_here" }
```
or
```json
{ "before": "2026-08-25T18:00:00+00:00" }
```

---

### Workspace Files Access
- `GET /instance/{workflow_id}/workspace` — Download workspace archive (`tar.zst`).
- `GET /instance/{workflow_id}/workspace/files` — List files in the workspace manifest.
- `GET /instance/{workflow_id}/workspace/file?path=relative/file.txt` — Stream individual file.

---

## Projects & Supervisor Endpoints

### Get Current Project
`GET /project/current`

Returns the active workspace supervisor Project detail.

### Spawn Task into Current Project
`POST /project/spawn`

**Request Body:**
```json
{
  "task_brief": "Review changes in pr-42",
  "payload": { "branch": "feature/auth" }
}
```

### List Projects / Detail by Slug
- `GET /project` — List all Projects.
- `GET /project/{slug}` — Get Project details by slug.
- `POST /project/{slug}/spawn` — Spawn child task into specific Project.

---

## Events & Streaming

- `POST /instance/{workflow_id}/message/{message_name}` — Deliver external message payload to waiting catch event.
- `GET /instance/{workflow_id}/events/pending` — List message and timer events the run is parked on.
- `GET /instance/{workflow_id}/events` — Audit event log.
- `GET /instance/{workflow_id}/events/stream` — SSE stream of state transitions and logs.
- `WS /ws/instance/{workflow_id}` — WebSocket stream for live UI push.

---

## Templates & History

- `GET /api/templates` — List available BPMN workflow templates.
- `GET /api/templates/{id}` — Get template details and variables schema.
- `GET /api/templates/{id}/xml` — Download raw BPMN 2.0 XML.
- `GET /api/history/instances` — List history records with pagination (`limit`, `offset`, `status`).
- `POST /api/history/pack` — Compact ZODB FileStorage.
- `DELETE /api/history/instances/{workflow_id}` — Delete instance history record.

---

## Observability & Health

- `GET /health` — Health check endpoint.
- `GET /metrics` — Prometheus metrics exposition.
