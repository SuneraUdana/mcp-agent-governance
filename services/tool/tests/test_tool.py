from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {
        "status": "ok",
        "service": "demo-tool",
    }


def test_demo_tool_executes():
    response = client.post(
        "/v1/tools/invoke",
        json={
            "toolId": "demo-tool",
            "action": "invoke",
            "payload": {"message": "hello"},
            "correlationId": "corr-demo",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "executed"
    assert response.json()["correlationId"] == "corr-demo"


def test_unknown_tool_is_rejected_with_error_status():
    response = client.post(
        "/v1/tools/invoke",
        json={
            "toolId": "unknown-tool",
            "action": "invoke",
            "payload": {},
            "correlationId": "corr-unknown",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "unknown demo tool"
