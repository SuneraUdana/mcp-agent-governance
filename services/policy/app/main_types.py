from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class PolicyContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PolicyRule(PolicyContractModel):
    policy_id: str = Field(min_length=1)
    effect: Literal["allow", "deny"]
    tool_id: str = Field(min_length=1)
    actor_id: str | None = None
    action: str = Field(default="invoke", min_length=1)
    reason: str = Field(min_length=1)
    version: int = Field(default=1, ge=1)
    status: Literal["active", "disabled"] = "active"
    created_at: str | None = None
    updated_at: str | None = None


class AuthorizationRequest(PolicyContractModel):
    actor_id: str = Field(min_length=1)
    tool_id: str = Field(min_length=1)
    action: str = Field(default="invoke", min_length=1)
    context: dict[str, Any] = Field(default_factory=dict)


class AuthorizationDecision(PolicyContractModel):
    allowed: bool
    reason: str
    policy_id: str | None = None
