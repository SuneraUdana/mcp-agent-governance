from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="MCP Demo Tool", version="0.1.0")


class ToolInvocation(BaseModel):
    toolId: str = Field(min_length=1)
    action: str = Field(default="invoke", min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    correlationId: str = Field(min_length=1)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "demo-tool"}


@app.post("/v1/tools/invoke")
def invoke(request: ToolInvocation) -> dict[str, Any]:
    if request.toolId != "demo-tool":
        return {"toolId": request.toolId, "status": "rejected", "reason": "unknown demo tool"}
    return {
        "toolId": request.toolId,
        "status": "executed",
        "message": request.payload.get("message", "hello from the demo tool"),
        "action": request.action,
        "correlationId": request.correlationId,
    }
