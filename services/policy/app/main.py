from datetime import datetime, timezone
from typing import Any
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="MCP Policy Service", version="0.1.0")

class AuthorizationRequest(BaseModel):
    actor_id: str
    tool_id: str
    action: str = "invoke"
    context: dict[str, Any] = Field(default_factory=dict)

class AuthorizationDecision(BaseModel):
    allowed: bool
    reason: str
    policy_id: str | None = None

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "policy"}

@app.post("/v1/authorize", response_model=AuthorizationDecision)
def authorize(request: AuthorizationRequest) -> AuthorizationDecision:
    # Deliberately conservative foundation: deny until a policy engine is configured.
    return AuthorizationDecision(allowed=False, reason="No policy configured")

@app.post("/v1/audit")
def audit(event: dict[str, Any]) -> dict[str, Any]:
    return {"accepted": True, "receivedAt": datetime.now(timezone.utc).isoformat(), "event": event}
