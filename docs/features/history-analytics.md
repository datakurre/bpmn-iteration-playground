# Process History & Storage Management

The Process History view in **graph-agent** provides full visibility into past workflow runs, variable state diffs across savepoints, and database maintenance controls.

---

## 1. History Overview (`/history`)

The history view aggregates completed, active, and failed workflow executions in ZODB:

![Process History](../images/process-history.png)

### Features & Capabilities:
- **Summary Metrics**: Real-time KPI summary showing **Total Processes**, **Completed Count**, and **Total Recorded Save Points**.
- **Status Filter Tabs**: Filter instances by execution state (`All Processes`, `Completed`, `Failed`, `Waiting Human`).
- **Card Actions**:
  - **Inspect History**: Opens the Savepoint & Variable Inspector for the chosen instance.
  - **View Diagram**: Navigates directly to the live BPMN diagram view.
  - **Delete**: Permanently removes the historical instance record.
- **Clear All History**: Purges historical workflow records.

---

## 2. Save Point & Variable Inspector (`/history/{workflow_id}`)

Clicking **Inspect History** on any workflow instance opens the deep inspection view:

![Save Point Inspector](../images/savepoint-inspector.png)

- **Interactive Save Point Timeline**: Click any recorded checkpoint (`before_harness`, `after_harness`, `human_wait`) to view the exact payload at that timestamp.
- **Variable Inspector**: Formatted JSON viewer displaying variable values at the selected save point.
- **One-Click Forking**: Branch a new live workflow execution directly from the selected historical save point (in `worktree` and `blob` modes).
- **Direct Deletion**: Top-right **Delete** action to remove the current workflow record.

---

## 3. Data Lifecycle API Endpoints

Historical records and database storage are managed via `/api/history/*`:

```http
# Query history instances with pagination
GET /api/history/instances?status=completed&limit=20

# Pack / compact ZODB FileStorage
POST /api/history/pack

# Delete a specific workflow instance
DELETE /api/history/instances/{workflow_id}

# Clear all historical instances
DELETE /api/history/instances?confirm=DELETE_ALL
```
