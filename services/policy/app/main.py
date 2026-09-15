from datetime import datetime, timezone
import json
import os
from typing import Any, Literal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="MCP Policy Service", version="0.1.0")

class PolicyRule(BaseModel):
    policy_id: str = Field(min_length=1)
    effect: Literal["allow", "deny"]
    tool_id: str = Field(min_length=1)
    actor_id: str | None = None
    action: str = Field(default="invoke", min_length=1)
    reason: str = Field(min_length=1)

class AuthorizationRequest(BaseModel):
    actor_id: str
    tool_id: str
    action: str = "invoke"
    context: dict[str, Any] = Field(default_factory=dict)

class AuthorizationDecision(BaseModel):
    allowed: bool
    reason: str
    policy_id: str | None = None

def load_rules() -> list[PolicyRule]:
    raw = os.getenv("POLICY_RULES_JSON", "[]")
    try:
        values = json.loads(raw)
        if not isinstance(values, list):
            raise ValueError("POLICY_RULES_JSON must be a JSON array")
        return [PolicyRule.model_validate(value) for value in values]
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"invalid POLICY_RULES_JSON: {error}") from error

policy_rules: list[PolicyRule] = load_rules()

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "policy"}

@app.post("/v1/authorize", response_model=AuthorizationDecision)
def authorize(request: AuthorizationRequest) -> AuthorizationDecision:
    for rule in policy_rules:
        if (
            rule.tool_id == request.tool_id
            and rule.action == request.action
            and (rule.actor_id is None or rule.actor_id == request.actor_id)
        ):
            return AuthorizationDecision(
                allowed=rule.effect == "allow",
                reason=rule.reason,
                policy_id=rule.policy_id,
            )
    return AuthorizationDecision(allowed=False, reason="No matching policy")

@app.get("/v1/policies", response_model=list[PolicyRule])
def list_policies() -> list[PolicyRule]:
    return policy_rules

@app.post("/v1/policies", response_model=PolicyRule, status_code=201)
def create_policy(rule: PolicyRule) -> PolicyRule:
    if any(existing.policy_id == rule.policy_id for existing in policy_rules):
        raise HTTPException(status_code=409, detail="policy already exists")
    policy_rules.append(rule)
    return rule

@app.post("/v1/audit")
def audit(event: dict[str, Any]) -> dict[str, Any]:
    return {"accepted": True, "receivedAt": datetime.now(timezone.utc).isoformat(), "event": event}
