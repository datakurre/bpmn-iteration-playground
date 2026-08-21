import pytest
from fastapi.testclient import TestClient

from app.api.server import create_app
from app.persistence import WorkflowStore
from app.pi_rpc import PiResult
from app.workflow_service import WorkflowService


class FakePi:
    calls = 0

    async def run(self, prompt: str, cwd: str) -> PiResult:
        self.calls += 1
        return PiResult(
            "success",
            {
                "status": "success",
                "summary": "complete",
                "findings": ["sample finding"],
                "artifacts": [],
                "next_action": "continue",
            },
            "result",
            [],
            "",
            0,
        )


@pytest.fixture
def store():
    s = WorkflowStore(":memory:")
    yield s
    s.close()


@pytest.fixture
def service(store):
    return WorkflowService(store, FakePi())


@pytest.fixture
def app(service):
    return create_app(service)


@pytest.fixture
def client(app):
    return TestClient(app)
