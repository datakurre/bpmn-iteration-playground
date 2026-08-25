# Web Interface & FormJS Human Review

**graph-agent** provides a browser-based Workflow Studio interface with an interactive 3-column layout, light/dark themes, live BPMN diagrams, FormJS human review checkpoints with Markdown previews, and visual SavePoint timeline management.

---

## 1. Studio Dashboard (`/`)

The Studio Dashboard allows users to launch workflow runs and monitor workflows requiring human review:

![Studio Dashboard](../images/studio-dashboard.png)

- **Template Launch**: Select any discovered BPMN template (e.g. `plan_and_execute.bpmn`, `document_generation.bpmn`, `contract_review.bpmn`) and configure input variables.
- **Action-Required Inbox**: Badges for instances waiting at human review checkpoints (`waiting_human`) or deferred merges (`merge_deferred`).
- **Live Status Indicator**: Real-time polling showing instance lifecycle (`idle`, `waiting_pi`, `waiting_human`, `completed`, `failed`).
- **Execution Stream**: Reverse-chronological list of executed tasks.

---

## 2. Interactive BPMN Diagram & 3-Column Layout (`/instance/{workflow_id}`)

Powered by [`bpmn-js`](https://bpmn.io/toolkit/bpmn-js/), the instance view renders standard BPMN 2.0 XML with live dynamic overlays and side-by-side inspection columns:

![Live Instance Diagram and Review Checkpoint](../images/docgen-review-checkpoint.png)

- **3-Column Workspace**:
  - **Column 1 (BPMN Canvas)**: Interactive diagram with zoom/fit controls, minimap overlay, and fullscreen toggle (`Alt+S`).
  - **Column 2 (Checkpoints & Tasks)**: FormJS human review card, status badges, and execution task stream.
  - **Column 3 (Timeline & Workspace)**: Workspace Files manifest, live Workflow Data JSON payload, and SavePoints timeline.
- **Vertical Resizers**: Drag horizontal handles to expand canvas and workspace heights.

---

## 3. Dynamic FormJS Review Checkpoints

Human review tasks integrate [`@bpmn-io/form-js`](https://bpmn.io/toolkit/form-js/) to render interactive schema-driven forms:

- **Live Markdown Preview**: FormJS renders generated documents in styled GitHub markdown.
- **In-Place Content Editing**: Reviewers edit text directly in form text areas.
- **Decision & Feedback**: Operators submit approval decisions with structured review feedback.
- Submitting the form posts variables to `/instance/{id}/submit-task/{task_id}`, advancing BPMN execution.

---

## 4. Workspace Files & On-Demand Extraction

Generated artifacts are stored according to the active `WorkspaceStrategy`:

- Under `worktree` and `in_place` modes, files live directly in the workspace directory.
- Under `blob` mode, files are packaged as compressed `tar.zst` blobs in ZODB with single-file on-demand streaming (`GET /instance/{id}/workspace/file?path=...`).
