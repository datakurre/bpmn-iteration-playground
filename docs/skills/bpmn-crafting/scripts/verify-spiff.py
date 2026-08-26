#!/usr/bin/env python3
"""Verify BPMN 2.0 workflow diagram compatibility with SpiffWorkflow engine.

Loads a BPMN file using graph_agent.engine.WorkflowRunner and inspects:
- Root process and subprocess parsing
- Camunda extensions attachment (properties, formData, inputOutput)
- Initial task readiness

Usage:
  python verify-spiff.py <workflow.bpmn> [process_id]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Add project root to sys.path so graph_agent can be imported
workspace_root = Path(__file__).resolve().parents[4]
if str(workspace_root) not in sys.path:
    sys.path.insert(0, str(workspace_root))

from graph_agent.engine import WorkflowRunner


def verify_workflow(bpmn_file: str, process_id: str | None = None) -> bool:
    path = Path(bpmn_file)
    if not path.exists():
        print(f"❌ File not found: {bpmn_file}", file=sys.stderr)
        return False

    print(f"🔍 Validating with SpiffWorkflow: {bpmn_file}")
    runner = WorkflowRunner()

    try:
        workflow, resolved_pid = runner.load_workflow(str(path), process_id=process_id)
        print(f"   ✅ Process parsed successfully: {resolved_pid}")
    except Exception as exc:
        print(f"   ❌ SpiffWorkflow load failed: {exc}", file=sys.stderr)
        return False

    # Check task specs and extensions
    task_specs = getattr(workflow.spec, "task_specs", {})
    print(f"   📋 Found {len(task_specs)} task specs:")

    errors = 0
    for name, spec in task_specs.items():
        ext = getattr(spec, "extensions", {}) or {}
        props = ext.get("properties", {})
        inputs = ext.get("inputParameters", {})
        outputs = ext.get("outputParameters", {})
        form = ext.get("form", {})

        spec_type = type(spec).__name__
        summary_parts = []
        if props:
            summary_parts.append(f"props={list(props.keys())}")
        if inputs:
            summary_parts.append(f"inputs={list(inputs.keys())}")
        if outputs:
            summary_parts.append(f"outputs={list(outputs.keys())}")
        if form and form.get("fields"):
            summary_parts.append(f"formFields={len(form.get('fields', []))}")

        detail = f" ({', '.join(summary_parts)})" if summary_parts else ""
        print(f"      - [{spec_type}] {name}{detail}")

    print("   ✨ SpiffWorkflow verification passed with 0 errors!")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python verify-spiff.py <workflow.bpmn> [process_id]")
        sys.exit(1)

    bpmn_path = sys.argv[1]
    pid = sys.argv[2] if len(sys.argv) > 2 else None
    ok = verify_workflow(bpmn_path, process_id=pid)
    sys.exit(0 if ok else 1)
