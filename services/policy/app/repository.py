from __future__ import annotations

import os
from typing import Protocol

from .main_types import PolicyRule


class PolicyRepository(Protocol):
    def list(self) -> list[PolicyRule]: ...
    def get(self, policy_id: str) -> PolicyRule | None: ...
    def create(self, rule: PolicyRule) -> PolicyRule: ...
    def authorize(self, actor_id: str, tool_id: str, action: str) -> PolicyRule | None: ...
    def close(self) -> None: ...


class MemoryPolicyRepository:
    def __init__(self, rules: list[PolicyRule] | None = None) -> None:
        self._rules: dict[str, PolicyRule] = {rule.policy_id: rule for rule in rules or []}

    def list(self) -> list[PolicyRule]:
        return list(self._rules.values())

    def get(self, policy_id: str) -> PolicyRule | None:
        return self._rules.get(policy_id)

    def create(self, rule: PolicyRule) -> PolicyRule:
        self._rules[rule.policy_id] = rule
        return rule

    def authorize(self, actor_id: str, tool_id: str, action: str) -> PolicyRule | None:
        matches = [
            rule for rule in self._rules.values()
            if rule.tool_id == tool_id
            and rule.action == action
            and (rule.actor_id is None or rule.actor_id == actor_id)
        ]
        return sorted(
            matches,
            key=lambda rule: (
                rule.actor_id is not None,
                rule.effect == "deny",
                rule.version,
                rule.policy_id,
            ),
            reverse=True,
        )[0] if matches else None

    def close(self) -> None:
        return None


class PostgresPolicyRepository:
    def __init__(self, database_url: str) -> None:
        import psycopg
        from psycopg.rows import dict_row

        self._psycopg = psycopg
        self._connection = psycopg.connect(database_url, row_factory=dict_row)

    def list(self) -> list[PolicyRule]:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT policy_id, effect, tool_id, actor_id, action, reason, version "
                "FROM policies WHERE status = 'active' ORDER BY policy_id"
            )
            return [PolicyRule.model_validate(row) for row in cursor.fetchall()]

    def get(self, policy_id: str) -> PolicyRule | None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT policy_id, effect, tool_id, actor_id, action, reason, version "
                "FROM policies WHERE policy_id = %s AND status = 'active'",
                (policy_id,),
            )
            row = cursor.fetchone()
            return PolicyRule.model_validate(row) if row else None

    def create(self, rule: PolicyRule) -> PolicyRule:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO policies "
                "(policy_id, effect, tool_id, actor_id, action, reason, version) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (rule.policy_id, rule.effect, rule.tool_id, rule.actor_id,
                 rule.action, rule.reason, rule.version),
            )
        self._connection.commit()
        return rule

    def authorize(self, actor_id: str, tool_id: str, action: str) -> PolicyRule | None:
        with self._connection.cursor() as cursor:
            cursor.execute(
                "SELECT policy_id, effect, tool_id, actor_id, action, reason, version "
                "FROM policies WHERE status = 'active' AND tool_id = %s "
                "AND action = %s AND (actor_id IS NULL OR actor_id = %s) "
                "ORDER BY (actor_id IS NOT NULL) DESC, (effect = 'deny') DESC, "
                "version DESC, policy_id DESC LIMIT 1",
                (tool_id, action, actor_id),
            )
            row = cursor.fetchone()
            return PolicyRule.model_validate(row) if row else None

    def close(self) -> None:
        self._connection.close()


def create_policy_repository(env: dict[str, str] | None = None) -> PolicyRepository:
    settings = env or os.environ
    if settings.get("POLICY_REPOSITORY") == "postgres":
        database_url = settings.get("DATABASE_URL")
        if not database_url:
            raise RuntimeError("DATABASE_URL is required when POLICY_REPOSITORY=postgres")
        return PostgresPolicyRepository(database_url)
    return MemoryPolicyRepository()
