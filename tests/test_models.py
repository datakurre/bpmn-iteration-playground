import pytest
from pydantic import ValidationError
from app.models import StartWorkflowRequest, SubmitTaskRequest, ForkRequest


def test_valid_variables() -> None:
    req = StartWorkflowRequest(variables={"a": 1, "b": [1, 2, {"c": "d"}]})
    assert req.variables["a"] == 1


def test_variables_oversized_rejected() -> None:
    huge_dict = {"data": "x" * (1024 * 1024 + 10)}
    with pytest.raises(ValidationError) as exc:
        StartWorkflowRequest(variables=huge_dict)
    assert "maximum size" in str(exc.value)


def test_variables_deep_nesting_rejected() -> None:
    from typing import Any
    nested: Any = {"k": "v"}
    for _ in range(15):
        nested = {"nested": nested}
    with pytest.raises(ValidationError) as exc:
        SubmitTaskRequest(variables=nested)
    assert "depth" in str(exc.value)


def test_variables_fork_request_validated() -> None:
    huge_dict = {"data": "x" * (1024 * 1024 + 10)}
    with pytest.raises(ValidationError) as exc:
        ForkRequest(variables=huge_dict)
    assert "maximum size" in str(exc.value)
