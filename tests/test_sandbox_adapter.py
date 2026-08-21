import json
import os
import stat
from pathlib import Path
import pytest

from app.adapters.sandbox_adapter import SandboxPiAdapter
from app.adapters.sandbox_policy import build_agents_md
from app.engine import WorkflowRunner
from app.workflow_service import WorkflowService
from app.persistence import WorkflowStore


def test_build_agents_md_defaults() -> None:
    md = build_agents_md({})
    assert "```toml agent-sandbox" in md
    assert "[network]" in md
    assert "opencode.ai:443" in md


def test_build_agents_md_custom_hosts_and_routes() -> None:
    config = {
        "allowed_hosts": "api.github.com:443, custom.service.io:8443",
        "allowed_routes": json.dumps([
            {
                "host": "custom.service.io:8443",
                "method": "POST",
                "path": "/api/v1/**",
                "secret": "CUSTOM_API_KEY",
                "header": "Authorization",
                "prefix": "Bearer ",
            }
        ]),
        "ports": json.dumps({"web": 8080}),
    }
    md = build_agents_md(config)
    assert "api.github.com:443" in md
    assert "custom.service.io:8443" in md
    assert "web = 8080" in md
    assert "[[network.allowed_routes]]" in md
    assert 'path = "/api/v1/**"' in md
    assert 'secret = "CUSTOM_API_KEY"' in md


def test_build_agents_md_raw_policy() -> None:
    raw = """```toml agent-sandbox
[network]
allowed_hosts = ["strict.domain.org:443"]
```
# Custom Policy
"""
    config = {"sandbox_policy": raw}
    md = build_agents_md(config)
    assert md.strip() == raw.strip()


@pytest.mark.anyio
async def test_sandbox_adapter_execution(tmp_path: Path) -> None:
    # Create a mock agent-sandbox script
    mock_sandbox = tmp_path / "mock-agent-sandbox.py"
    mock_sandbox.write_text("""#!/usr/bin/env python3
import json, sys

# Read prompt from stdin
prompt = sys.stdin.read()
args = sys.argv[1:]

events = [
    json.dumps({"type": "session", "id": "test-sandbox-session-42"}),
    json.dumps({
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "text",
                "text": json.dumps({
                    "status": "success",
                    "summary": "Completed in sandbox",
                    "findings": args,
                    "artifacts": ["sandbox_result.txt"],
                    "next_action": "continue"
                })
            }]
        }
    }),
    json.dumps({"type": "agent_settled"})
]

output_payload = {
    "status": 0,
    "stdout": "\\n".join(events),
    "stderr": "",
    "network": {
        "summary": [
            {"host": "opencode.ai:443", "bytes_up": 100, "bytes_down": 500, "connections": 1, "verdict": "allow"}
        ],
        "denied": [],
        "proposed_policy": None
    }
}
print(json.dumps(output_payload))
""")
    mock_sandbox.chmod(mock_sandbox.stat().st_mode | stat.S_IEXEC)

    adapter = SandboxPiAdapter(executable=str(mock_sandbox))
    assert adapter.adapter_type == "sandbox_pi"

    collected_events = []
    async def on_event(ev: dict) -> None:
        collected_events.append(ev)

    res = await adapter.run(
        prompt="Execute task",
        config={"model": "gpt-5.6-luna", "session_id": "prev-session-1", "fork": "false"},
        cwd=str(tmp_path),
        on_event=on_event,
    )

    assert res.status == "success"
    assert res.exit_code == 0
    assert res.session_id == "test-sandbox-session-42"
    assert res.output is not None
    assert res.output["status"] == "success"
    assert res.output["summary"] == "Completed in sandbox"
    assert res.network is not None
    assert len(res.network["summary"]) == 1
    assert res.network["summary"][0]["host"] == "opencode.ai:443"
    assert len(collected_events) == 3


@pytest.mark.anyio
async def test_sandbox_adapter_policy_error(tmp_path: Path) -> None:
    mock_sandbox = tmp_path / "mock-denied-sandbox.py"
    mock_sandbox.write_text("""#!/usr/bin/env python3
import json

output_payload = {
    "status": 1,
    "stdout": "",
    "stderr": "agent-sandbox: ssh to api.github.com:22 denied by allow_signing policy",
    "network": {
        "summary": [],
        "denied": [{"host": "api.github.com:22", "verdict": "deny", "method": "SSH", "path": None, "err": "denied by policy"}],
        "proposed_policy": "```toml agent-sandbox\\n[network]\\nallowed_hosts = [\\\"api.github.com:22\\\"]\\n```"
    },
    "policy_error": "agent-sandbox: ssh to api.github.com:22 denied by allow_signing policy"
}
print(json.dumps(output_payload))
""")
    mock_sandbox.chmod(mock_sandbox.stat().st_mode | stat.S_IEXEC)

    adapter = SandboxPiAdapter(executable=str(mock_sandbox))
    res = await adapter.run(
        prompt="Execute task",
        config={},
        cwd=str(tmp_path),
    )

    assert res.status == "failed"
    assert res.exit_code == 1
    assert res.policy_error is not None
    assert "denied by allow_signing policy" in res.policy_error
    assert res.network is not None
    assert len(res.network["denied"]) == 1


@pytest.mark.anyio
async def test_workflow_service_with_sandbox_adapter_multi_turn(tmp_path: Path) -> None:
    # Mock sandbox script that records sessions
    session_log = tmp_path / "sessions.log"
    mock_sandbox = tmp_path / "mock-sandbox-turns.py"
    mock_sandbox.write_text(f"""#!/usr/bin/env python3
import json, sys

prompt = sys.stdin.read()
args = sys.argv[1:]

with open("{session_log}", "a") as f:
    f.write(json.dumps({{"args": args, "prompt": prompt}}) + "\\n")

session_id = "session-turn-1"
if "--session" in args:
    idx = args.index("--session")
    session_id = args[idx + 1] + "-continued"
elif "--fork" in args:
    idx = args.index("--fork")
    session_id = args[idx + 1] + "-forked"

events = [
    json.dumps({{"type": "session", "id": session_id}}),
    json.dumps({{
        "type": "message_end",
        "message": {{
            "role": "assistant",
            "content": [{{
                "type": "text",
                "text": json.dumps({{
                    "status": "success",
                    "summary": "Turn completed",
                    "findings": args,
                    "artifacts": [],
                    "next_action": "continue"
                }})
            }}]
        }}
    }}),
    json.dumps({{"type": "agent_settled"}})
]

print(json.dumps({{
    "status": 0,
    "stdout": "\\n".join(events),
    "stderr": "",
    "network": {{
        "summary": [{{"host": "opencode.ai:443", "bytes_up": 50, "bytes_down": 200, "connections": 1, "verdict": "allow"}}],
        "denied": []
    }}
}}))
""")
    mock_sandbox.chmod(mock_sandbox.stat().st_mode | stat.S_IEXEC)

    store = WorkflowStore(":memory:")
    adapter = SandboxPiAdapter(executable=str(mock_sandbox))
    service = WorkflowService(store, pi_client=adapter)

    state = await service.start("workflows/plan_and_execute.bpmn")
    workflow_id = state["workflow_id"]

    async def _wait_jobs() -> None:
        while any(not job.done() for job in list(service.jobs.values())):
            pending = [job for job in list(service.jobs.values()) if not job.done()]
            if pending:
                await asyncio.gather(*pending)
            await asyncio.sleep(0.01)

    import asyncio
    await asyncio.wait_for(_wait_jobs(), timeout=5.0)

    state = service.state(workflow_id)
    assert state["status"] == "waiting_human"
    assert state["pi_session_id"] == "session-turn-1"
    assert state.get("network") is not None

    # Submit human approval to proceed to turn 2
    tasks = state["tasks"]
    human_task = next(t for t in tasks if t["state"] == "READY" and t.get("type") == "UserTask")
    await service.submit_task(workflow_id, human_task["id"], {"plan_approval": "approved"})
    await asyncio.wait_for(_wait_jobs(), timeout=5.0)

    state2 = service.state(workflow_id)
    assert state2["status"] == "waiting_human"
    assert state2["pi_session_id"] == "session-turn-1-continued"

    # Complete final signoff
    verify_task = next(t for t in state2["tasks"] if t["state"] == "READY" and t.get("type") == "UserTask")
    final_state = await service.submit_task(workflow_id, verify_task["id"], {"signoff_decision": "accepted"})
    assert final_state["status"] == "completed"

    # Verify sessions.log records that turn 2 passed --session session-turn-1
    entries = [json.loads(line) for line in session_log.read_text().splitlines() if line]
    assert len(entries) == 2
    assert "--session" not in entries[0]["args"]
    assert "--session" in entries[1]["args"]
    idx = entries[1]["args"].index("--session")
    assert entries[1]["args"][idx + 1] == "session-turn-1"
