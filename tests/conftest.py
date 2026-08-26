import pytest
from fastapi.testclient import TestClient

from graph_agent.api.server import create_app
from graph_agent.persistence import WorkflowStore
from graph_agent.pi_client import PiResult
from graph_agent.workflow_service import WorkflowService


@pytest.fixture(autouse=True)
def _isolate_xdg_config(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    test_xdg = tmp_path_factory.mktemp("xdg_config")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(test_xdg))


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
    with TestClient(app) as c:
        yield c
