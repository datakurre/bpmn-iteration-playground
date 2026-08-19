# Web Interface & FormJS Human Review

Pi Workflow Studio provides a responsive web interface with a high-contrast 3-column layout, instant light/dark theme toggling, interactive BPMN diagrams, FormJS human checkpoints with live Markdown previews, sandboxed workspace file extraction, and vertical canvas resizers.

---

## 1. Studio Dashboard (`/`)

The Studio Dashboard allows users to launch new process instances and monitor active workflows requiring attention.

![Studio Dashboard](../images/studio-dashboard.png)

- **Process Launch Form**: Select any registered BPMN template (e.g. `Document Generation`, `Contract Review`) and configure execution parameters.
- **Action-Required Banner**: Prominent badges for instances waiting at human review checkpoints.
- **Live Status Indicator**: Real-time polling showing instance lifecycle (`idle`, `waiting_pi`, `waiting_human`, `completed`, `failed`).
- **Persisted Tasks Stream**: Reverse-chronological list of executed tasks with newest events at the top.

---

## 2. Interactive BPMN Diagram & 3-Column Layout (`/instance/{workflow_id}`)

Powered by [`bpmn-js`](https://bpmn.io/toolkit/bpmn-js/), the instance view renders standard BPMN 2.0 XML with live dynamic overlays and side-by-side inspection columns:

![Live Instance Diagram and Review Checkpoint](../images/docgen-review-checkpoint.png)

- **3-Column Workspace**:
  - **Column 1 (BPMN Canvas)**: Interactive diagram with floating zoom/fit controls, minimap overlay, and fullscreen toggle (`Alt+S`).
  - **Column 2 (Checkpoints & Tasks)**: FormJS human review card, status badges, and execution task stream.
  - **Column 3 (Timeline & Workspace)**: Workspace Files manifest, live Workflow Data JSON payload, and Save Points timeline.
- **Vertical Resizers**:
  - **Desktop 3-Panel Resizer**: Drag the horizontal handle below the panels to expand workspace height (up to 2200px).
  - **Mobile Stacked Resizer**: Drag the divider handle on mobile viewports to adjust diagram height.

---

## 3. Dynamic FormJS Review Checkpoints & Iteration

Human review tasks integrate [`@bpmn-io/form-js`](https://bpmn.io/toolkit/form-js/) to render interactive schema-driven forms:

- **Live Markdown Preview**: FormJS renders generated documents (`doc_preview`) in styled GitHub markdown.
- **In-Place Content Editing**: Reviewers can edit text directly in the `document_content` textarea.
- **Revision Decision & Feedback**: Operators can approve (`approved`) or request revision loops (`revise`) with structured feedback.
- Submitting the form posts variables to `/instance/{id}/submit-task/{task_id}`, continuing BPMN process execution.

---

## 4. Workspace Files & On-Demand Extraction

Generated artifacts (e.g. `document.md`) are persisted as compressed `.tar.zst` packages in ZODB with a lightweight metadata index:

- **Single-File Streaming**: Click `[View]` to extract and inspect individual files on demand (`GET /instance/{id}/workspace/file?path=...`) without decompressing the full archive.
- **Full Workspace Download**: Download the complete compressed package with one click.

---

## 5. Completed Workflow Trace

Once all tasks complete, the instance page reflects the finished state with full task histories, save points, and generated payloads:

![Completed Workflow Instance](../images/instance-completed.png)

