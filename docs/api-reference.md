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

Creates a new branched instance rooted at the specified savepoint, with an independent
duplicate of that savepoint's workspace blob.

---

### Purge Save Points
`DELETE /instance/{workflow_id}/savepoints`

Deletes every savepoint older than an anchor, releasing its workspace blob. Requires
`OPERATOR` or higher, like the other destructive routes.

**Request Body** — exactly one anchor:
```json
{ "before_task_id": "7fae39ca-8cb1-4b73-8ffa-9c17aea56859" }
```
```json
{ "before": "2026-08-21T18:43:32+00:00" }
```

**Response:**
```json
{ "purged": 2, "remaining": 3 }
```

Both anchors satisfy one invariant: **a task's savepoints are never split.** An agent task
records both a `before_harness` and an `after_harness` savepoint, so a cut-off landing between
them resolves back to that task's oldest savepoint and the task survives whole; a task
entirely older than the cut-off is still removed whole.

Supplying neither anchor or both returns `400` — a malformed request is never read as
"purge all". Retention is deliberately manual; there is no scheduled or automatic expiry.

---

### Workspace Access
- `GET /instance/{workflow_id}/workspace` — Download the whole workspace as a `tar.zst` archive.
- `GET /instance/{workflow_id}/workspace/files` — File manifest (`file_count`, `total_size`, `files[]`, `artifacts[]`).
- `GET /instance/{workflow_id}/workspace/file?path=document.md` — Stream a single file out of the archive without unpacking it.

The manifest is also included on the instance state as `workspace_metadata`, which is what the
instance view's **Workspace Files** panel renders.

---

## Events, Messages & Timers

### Deliver an External Message
`POST /instance/{workflow_id}/message/{message_name}`

Delivers a payload to a waiting message catch event, or spawns a child from an event
subprocess whose message start event matches.

**Request Body:**
```json
{ "payload": { "task_brief": "Audit the docs tree against shipped features" } }
```

The payload lands on the receiving scope's data, including a subprocess created by this very
message — so a freshly spawned child can read what it was spawned to do.

### Inspect What an Instance Is Waiting On
`GET /instance/{workflow_id}/events/pending`

Lists the message and timer events the instance is currently parked on.

### Audit Log & Streams
- `GET /instance/{workflow_id}/events` — Full audit event log for the instance.
- `GET /instance/{workflow_id}/events/stream` — Server-sent events stream of state transitions.

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

## Observability

- `GET /health` — Public, unauthenticated liveness check.
- `GET /metrics` — Prometheus exposition: instance counts by status, ZODB size, active jobs.

---

## WebSocket Real-Time Push
`ws://localhost:8000/ws/instance/{workflow_id}`

Streams live state transitions and log events directly to browser clients.
