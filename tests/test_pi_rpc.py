import json

from app.pi_rpc import _parse_json


def test_parse_pi_json_result() -> None:
    result = {
        "status": "success",
        "summary": "ok",
        "findings": [],
        "artifacts": [],
        "next_action": "continue",
    }
    assert _parse_json(json.dumps(result)) == result
    assert _parse_json("```json\n" + json.dumps(result) + "\n```") == result
    assert _parse_json('{"status":"success"}') is None
    assert _parse_json("not json") is None
