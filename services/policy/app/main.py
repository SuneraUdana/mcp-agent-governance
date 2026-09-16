from datetime import datetime, timezone
import json
import os
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .main_types import PolicyRule
from .repository import MemoryPolicyRepository, PolicyRepository, create_policy_repository

app = FastAPI(title="MCP Policy Service", version="0.2.0")


class AuthorizationRequest(BaseModel):
    actor_id: str
    tool_id: str
    action: str = "invoke"
    context: dict[str, Any] = Field(default_factory=dict)


class AuthorizationDecision(BaseModel):
    allowed: bool
    reason: str
    policy_id: str | None = None


def configured_repository() -> PolicyRepository:
    if os.getenv("POLICY_REPOSITORY", "memory") == "memory":
        raw = os.getenv("POLICY_RULES_JSON", "[]")
        try:
            values = json.loads(raw)
            if not isinstance(values, list):
                raise ValueError("POLICY_RULES_JSON must be a JSON array")
            return MemoryPolicyRepository([PolicyRule.model_validate(value) for value in values])
        except (json.JSONDecodeError, ValueError) as error:
            raise RuntimeError(f"invalid POLICY_RULES_JSON: {error}") from error
    return create_policy_repository()


policy_repository = configured_repository()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "policy"}


@app.post("/v1/authorize", response_model=AuthorizationDecision)
def authorize(request: AuthorizationRequest) -> AuthorizationDecision:
    rule = policy_repository.authorize(request.actor_id, request.tool_id, request.action)
    if not rule:
        return AuthorizationDecision(allowed=False, reason="No matching policy")
    return AuthorizationDecision(
        allowed=rule.effect == "allow",
        reason=rule.reason,
        policy_id=rule.policy_id,
    )


@app.get("/v1/policies", response_model=list[PolicyRule])
def list_policies() -> list[PolicyRule]:
    return policy_repository.list()


@app.post("/v1/policies", response_model=PolicyRule, status_code=201)
def create_policy(rule: PolicyRule) -> PolicyRule:
    if policy_repository.get(rule.policy_id):
        raise HTTPException(status_code=409, detail="policy already exists")
    return policy_repository.create(rule)


@app.post("/v1/audit")
def audit(event: dict[str, Any]) -> dict[str, Any]:
    return {"accepted": True, "receivedAt": datetime.now(timezone.utc).isoformat(), "event": event}
