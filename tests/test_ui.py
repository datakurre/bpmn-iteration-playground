from graph_agent.api.ui import admin_page, editor_page, history_detail_page, history_page, instance_page, page


def test_page_builds_its_own_request_when_none_given() -> None:
    response = page()
    assert response.status_code == 200


def test_history_page_builds_its_own_request_when_none_given() -> None:
    response = history_page()
    assert response.status_code == 200


def test_admin_page_builds_its_own_request_when_none_given() -> None:
    response = admin_page()
    assert response.status_code == 200


def test_editor_page_builds_its_own_request_when_none_given() -> None:
    response = editor_page()
    assert response.status_code == 200


def test_instance_page_accepts_workflow_id_as_positional_string() -> None:
    response = instance_page("wf-123")
    assert response.status_code == 200
    assert b"wf-123" in response.body


def test_history_detail_page_accepts_workflow_id_as_positional_string() -> None:
    response = history_detail_page("wf-456")
    assert response.status_code == 200
    assert b"wf-456" in response.body
