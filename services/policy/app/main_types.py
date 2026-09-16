from typing import Literal

from pydantic import BaseModel, Field


class PolicyRule(BaseModel):
    policy_id: str = Field(min_length=1)
    effect: Literal["allow", "deny"]
    tool_id: str = Field(min_length=1)
    actor_id: str | None = None
    action: str = Field(default="invoke", min_length=1)
    reason: str = Field(min_length=1)
    version: int = Field(default=1, ge=1)
