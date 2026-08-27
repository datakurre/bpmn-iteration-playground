from graph_agent.pi_client import PiResult
from graph_agent.workflow_service import CAMUNDA_TO_FORMJS_TYPE


class FormTestPi:
    async def run(self, prompt: str, cwd: str) -> PiResult:
        return PiResult(
            "success",
            {"status": "success", "summary": "ok", "findings": [], "artifacts": [], "next_action": "continue"},
            "ok",
            [],
            "",
            0,
        )


def test_camunda_to_formjs_type_mapping() -> None:
    assert CAMUNDA_TO_FORMJS_TYPE["string"] == "textfield"
    assert CAMUNDA_TO_FORMJS_TYPE["text"] == "textfield"
    assert CAMUNDA_TO_FORMJS_TYPE["long"] == "number"
    assert CAMUNDA_TO_FORMJS_TYPE["double"] == "number"
    assert CAMUNDA_TO_FORMJS_TYPE["boolean"] == "checkbox"
    assert CAMUNDA_TO_FORMJS_TYPE["date"] == "textfield"
    assert CAMUNDA_TO_FORMJS_TYPE["enum"] == "select"
    # Unknown types fallback to textfield
    assert CAMUNDA_TO_FORMJS_TYPE.get("unknown_type", "textfield") == "textfield"
    assert CAMUNDA_TO_FORMJS_TYPE.get("custom_widget", "textfield") == "textfield"
