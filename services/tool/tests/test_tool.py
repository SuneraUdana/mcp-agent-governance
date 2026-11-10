from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {
        "status": "ok",
        "service": "demo-tool",
    }


def test_mcp_session_and_demo_tool_execute():
    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}},
    )
    assert response.status_code == 200
    assert response.headers["mcp-session-id"] == "demo-session"
    assert response.json()["result"]["protocolVersion"] == "2025-03-26"
    assert client.post(
        "/mcp",
        headers={"Mcp-Session-Id": "demo-session"},
        json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
    ).status_code == 202
    response = client.post(
        "/mcp",
        headers={"Mcp-Session-Id": "demo-session"},
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "demo-tool",
            "arguments": {"action": "invoke", "message": "hello", "correlationId": "corr-demo"},
        }},
    )
    assert response.status_code == 200
    assert response.json()["result"]["status"] == "executed"
    assert response.json()["result"]["correlationId"] == "corr-demo"


def test_unknown_tool_is_a_json_rpc_error():
    response = client.post(
        "/mcp",
        headers={"Mcp-Session-Id": "demo-session"},
        json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "unknown-tool", "arguments": {"correlationId": "corr-unknown"},
        }},
    )
    assert response.status_code == 200
    assert response.json()["error"]["code"] == -32602
