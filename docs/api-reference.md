# REST & WebSocket API Reference

The BPMN Pi Workflow server exposes full REST and WebSocket endpoints for orchestrating processes, monitoring state, submitting forms, and managing persistence.

## Authentication & Headers

| Header | Description | Default Role |
| :--- | :--- | :--- |
| `X-Admin-Token` | Admin secret token configured via `ADMIN_TOKEN` | `ADMIN` |
| `X-Api-Key` | API key configured via `API_KEYS=key:role` | Role mapped from key |

When no auth environment variables are set, the system runs in open development mode granting full `ADMIN` access.

---

## Workflow Endpoints

### Start Workflow Instance
`POST /workflow/start`

**Request Body:**
```json
{
  "bpmn_path": "workflows/contract_review.bpmn",
  "process_id": null,
  "variables": {
    "contract": "Non-Disclosure Agreement terms..."
  }
}
```

**Response (`WorkflowState`):**
```json
{
  "workflow_id": "a1b2c3d4e5f6",
  "status": "waiting_human",
  "process_id": "contract_review",
  "data": { ... },
  "tasks": [ ... ],
  "save_points": [ ... ]
}
```

---

### Get Instance State
`GET /workflow/{workflow_id}/state` or `GET /instance/{workflow_id}/state`

Returns the current execution state, active tasks, variable payload, and savepoints.

---

### Submit Human Task
`POST /instance/{workflow_id}/submit-task/{task_id}`

**Request Body:**
```json
{
  "variables": {
    "decision": "approved",
    "notes": "Reviewed and verified."
  }
}
```

---

### Cancel Instance
`POST /instance/{workflow_id}/cancel`

Cancels all pending background jobs and transitions the workflow status to `cancelled`.

---

### Retry Failed Task
`POST /instance/{workflow_id}/retry/{task_id}`

Re-triggers the execution harness for a failed agent task using the prior checkpoint.

---

### Fork from Savepoint
`POST /instance/{workflow_id}/fork/{save_point_id}`

**Request Body:**
```json
{
  "variables": {
    "override_key": "new_value"
  }
}
```

Creates a new branched instance rooted at the specified savepoint with duplicate workspace blob.

---

## Templates & Editor Endpoints

- `GET /api/templates` — List auto-discovered BPMN templates with documentation metadata.
- `GET /api/templates/{id}` — Get detailed template schema and input variables.
- `GET /api/templates/{id}/xml` — Download raw BPMN 2.0 XML string.
- `POST /api/workflows/save` — Save or create BPMN 2.0 diagram to `workflows/`.

---

## History & Storage Endpoints

- `GET /api/history/instances` — Query instances with `status`, `limit`, `offset`, `since`, `until`.
- `GET /api/history/storage` — Retrieve database size and instance counts.
- `POST /api/history/pack` — Run ZODB FileStorage compaction to reclaim space.
- `DELETE /api/history/instances/{workflow_id}` — Delete a specific instance.
- `DELETE /api/history/instances?confirm=DELETE_ALL` — Clear all history instances.

---

## Webhook Subscription Endpoints

- `GET /api/webhooks` — List active webhook subscriptions.
- `POST /api/webhooks` — Register a webhook URL for lifecycle events (`workflow_started`, `pi_completed`, etc.).
- `DELETE /api/webhooks/{id}` — Delete a webhook registration.

---

## WebSocket Real-Time Push
`ws://localhost:8000/ws/instance/{workflow_id}`

Streams live state transitions and log events directly to browser clients.
