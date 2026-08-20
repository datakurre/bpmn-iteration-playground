import json
from pathlib import Path
import pytest

from app.pi_client import PiClient, _parse_json


@pytest.mark.parametrize(
    "invalid_input",
    [
        "",
        "   ",
        "not json at all",
        "{invalid json",
        json.dumps({"status": "success"}),  # missing keys
        json.dumps({"status": "success", "summary": "s", "findings": [], "artifacts": []}),  # missing next_action
        json.dumps({"status": 123, "summary": "s", "findings": [], "artifacts": [], "next_action": "c"}),  # status not str
        json.dumps({"status": "s", "summary": 123, "findings": [], "artifacts": [], "next_action": "c"}),  # summary not str
        json.dumps({"status": "s", "summary": "s", "findings": "not list", "artifacts": [], "next_action": "c"}),  # findings not list
        json.dumps({"status": "s", "summary": "s", "findings": [], "artifacts": "not list", "next_action": "c"}),  # artifacts not list
        json.dumps({"status": "s", "summary": "s", "findings": [], "artifacts": [], "next_action": 123}),  # next_action not str
    ],
)
def test_parse_json_invalid_edge_cases(invalid_input: str) -> None:
    assert _parse_json(invalid_input) is None


def test_parse_json_valid_variants() -> None:
    valid = {
        "status": "success",
        "summary": "Valid summary",
        "findings": ["f1"],
        "artifacts": ["a1"],
        "next_action": "continue",
        "extra_key": "custom_value",
    }
    # Raw JSON
    assert _parse_json(json.dumps(valid)) == valid
    # Fenced JSON with ```json
    assert _parse_json(f"```json\n{json.dumps(valid)}\n```") == valid
    # Fenced JSON with ```
    assert _parse_json(f"```\n{json.dumps(valid)}\n```") == valid


@pytest.mark.anyio
async def test_pi_client_subprocess_real_execution(tmp_path: Path) -> None:
    demo_script = Path("scripts/pi-demo").resolve()
    assert demo_script.exists()

    client = PiClient(executable=str(demo_script), timeout_seconds=10)
    res = await client.run("Please draft a document", cwd=str(tmp_path))

    assert res.status == "success"
    assert res.exit_code == 0
    assert res.output is not None
    assert res.output["status"] == "success"
    assert res.output["summary"] != ""
    assert isinstance(res.output["findings"], list)
    assert (tmp_path / "document.md").exists()


@pytest.mark.anyio
async def test_pi_client_subprocess_error_exit(tmp_path: Path) -> None:
    script = tmp_path / "fail_pi.sh"
    script.write_text("""#!/bin/sh
echo "Fatal error in model process" >&2
exit 1
""")
    script.chmod(0o755)

    client = PiClient(executable=str(script), timeout_seconds=5)
    res = await client.run("test", cwd=str(tmp_path))

    assert res.status == "failed"
    assert res.exit_code == 1
    assert "Fatal error in model process" in res.stderr


@pytest.mark.anyio
async def test_pi_client_subprocess_invalid_json_output(tmp_path: Path) -> None:
    script = tmp_path / "bad_output_pi.py"
    script.write_text("""#!/usr/bin/env python3
import json

print(json.dumps({"type": "session"}))
print(json.dumps({
    "type": "message_end",
    "message": {"role": "assistant", "content": [{"type": "text", "text": "I am not returning valid JSON."}]}
}))
print(json.dumps({"type": "agent_settled"}))
""")
    script.chmod(0o755)

    client = PiClient(executable=str(script), timeout_seconds=5)
    res = await client.run("test", cwd=str(tmp_path))

    assert res.status == "failed"
    assert res.output is None
    assert "I am not returning valid JSON." in res.text


@pytest.mark.anyio
async def test_pi_client_timeout_captures_stderr(tmp_path: Path) -> None:
    script_path = tmp_path / "slow_pi.sh"
    script_path.write_text("""#!/bin/sh
echo "Diagnostic stderr before timeout" >&2
sleep 2
""")
    script_path.chmod(0o755)

    client = PiClient(executable=str(script_path), timeout_seconds=0.1)
    res = await client._execute(str(script_path), "test prompt", cwd=str(tmp_path))

    assert res.status == "timeout"
    assert "Diagnostic stderr before timeout" in res.stderr


@pytest.mark.anyio
async def test_pi_client_captures_session_id(tmp_path: Path) -> None:
    script = tmp_path / "session_pi.py"
    script.write_text("""#!/usr/bin/env python3
import json

print(json.dumps({"type": "session", "id": "test-session-uuid-12345"}))
print(json.dumps({
    "type": "message_end",
    "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps({
        "status": "success",
        "summary": "Done",
        "findings": [],
        "artifacts": [],
        "next_action": "continue"
    })}]}
}))
print(json.dumps({"type": "agent_settled"}))
""")
    script.chmod(0o755)

    client = PiClient(executable=str(script), timeout_seconds=5)
    res = await client.run("test", cwd=str(tmp_path))

    assert res.status == "success"
    assert res.session_id == "test-session-uuid-12345"


@pytest.mark.anyio
async def test_pi_client_passes_fork_and_session_flags(tmp_path: Path) -> None:
    script = tmp_path / "inspect_args_pi.py"
    script.write_text("""#!/usr/bin/env python3
import json, sys

args = sys.argv[1:]
print(json.dumps({"type": "session", "id": "new-branch-id"}))
print(json.dumps({
    "type": "message_end",
    "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps({
        "status": "success",
        "summary": "Args checked",
        "findings": args,
        "artifacts": [],
        "next_action": "continue"
    })}]}
}))
print(json.dumps({"type": "agent_settled"}))
""")
    script.chmod(0o755)

    client = PiClient(executable=str(script), timeout_seconds=5)

    # Test 1: Fork from existing trunk session
    res_fork = await client.run("test", cwd=str(tmp_path), session_id="trunk-123", fork=True)
    assert res_fork.status == "success"
    assert res_fork.output is not None
    assert "--fork" in res_fork.output["findings"]
    fork_idx = res_fork.output["findings"].index("--fork")
    assert res_fork.output["findings"][fork_idx + 1] == "trunk-123"
    assert "--session" not in res_fork.output["findings"]

    # Test 2: Resume session without fork
    res_session = await client.run("test", cwd=str(tmp_path), session_id="trunk-123", fork=False)
    assert res_session.status == "success"
    assert res_session.output is not None
    assert "--session" in res_session.output["findings"]
    session_idx = res_session.output["findings"].index("--session")
    assert res_session.output["findings"][session_idx + 1] == "trunk-123"
    assert "--fork" not in res_session.output["findings"]
