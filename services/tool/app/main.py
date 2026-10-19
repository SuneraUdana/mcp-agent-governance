from typing import Any

from fastapi import FastAPI, Header, Response
from pydantic import BaseModel, Field

app = FastAPI(title="MCP Demo Tool", version="0.1.0")


class JsonRpcRequest(BaseModel):
    jsonrpc: str
    id: str | int | None = None
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "demo-tool"}


@app.post("/mcp")
def mcp(
    request: JsonRpcRequest,
    response: Response,
    mcp_session_id: str | None = Header(default=None, alias="Mcp-Session-Id"),
) -> dict[str, Any] | None:
    if request.jsonrpc != "2.0":
        return rpc_error(request.id, -32600, "Invalid Request")
    if request.method == "initialize":
        response.headers["Mcp-Session-Id"] = "demo-session"
        return {
            "jsonrpc": "2.0",
            "id": request.id,
            "result": {
                "protocolVersion": request.params.get("protocolVersion", "2025-03-26"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mcp-demo-tool", "version": "0.1.0"},
            },
        }
    if request.method == "notifications/initialized":
        if mcp_session_id != "demo-session":
            response.status_code = 400
            return None
        response.status_code = 202
        return None
    if mcp_session_id != "demo-session":
        response.status_code = 400
        return rpc_error(request.id, -32000, "MCP session is required")
    if request.method != "tools/call":
        return rpc_error(request.id, -32601, "Method not found")
    name = request.params.get("name")
    arguments = request.params.get("arguments")
    if name != "demo-tool" or not isinstance(arguments, dict):
        return rpc_error(request.id, -32602, "Invalid tools/call parameters")
    return {
        "jsonrpc": "2.0",
        "id": request.id,
        "result": {
            "content": [{
                "type": "text",
                "text": arguments.get("message", "hello from the demo tool"),
            }],
            "toolId": name,
            "status": "executed",
            "action": arguments.get("action", "invoke"),
            "correlationId": arguments.get("correlationId"),
        },
    }


def rpc_error(request_id: str | int | None, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
