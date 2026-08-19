# Process History & Data Management

The Process History page provides complete visibility into past workflow runs, variable state diffs across save points, and direct controls for managing historical data storage.

---

## 1. History Overview (`/history`)

The history view aggregates all completed, active, and failed workflow executions in ZODB:

![Process History](../images/process-history.png)

### Features & Capabilities:
- **Summary Metrics**: Real-time KPI summary showing **Total Processes**, **Completed Count**, and **Total Recorded Save Points**.
- **Status Filter Tabs**: Filter instances instantly by execution state (`All Processes`, `Completed`, `Failed`, `Waiting Human`).
- **Responsive Scrollable Cards**: High-contrast, custom-styled vertical scrollbars ensure comfortable navigation across hundreds of workflow runs.
- **Card Actions**:
  - **Inspect History**: Opens the Savepoint & Variable Inspector for the chosen instance.
  - **View Diagram**: Navigates directly to the live BPMN diagram view.
  - **Delete**: Permanently removes the historical instance record.
- **Clear All History**: Prompts for confirmation to purge all historical workflow records in one operation.

---

## 2. Save Point & Variable Inspector (`/history/{workflow_id}`)

Clicking **Inspect History** on any workflow instance opens the deep inspection view:

![Save Point Inspector](../images/savepoint-inspector.png)

- **Completed BPMN Diagram**: Visual layout marking all executed BPMN nodes.
- **Interactive Save Point Timeline**: Click any recorded checkpoint (`before_harness`, `after_harness`, `human_wait`) to view the exact payload at that timestamp.
- **Variable Inspector**: Formatted JSON viewer displaying variable values at the selected save point.
- **Final Variables Payload**: Full final data dictionary when the process reached completion.
- **One-Click Forking**: Branch a new live workflow execution directly from the selected historical save point.
- **Direct Instance Deletion**: Top-right **Delete** action to remove the current workflow record and return to the history list.

---

## 3. Data Lifecycle API Endpoints

The frontend deletion controls map directly to RESTful deletion endpoints:

```http
# Delete a specific workflow instance
DELETE /api/history/instances/{workflow_id}

# Clear all historical instances
DELETE /api/history/instances
```
