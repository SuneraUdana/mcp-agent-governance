import os
from types import SimpleNamespace
import pytest
os.environ["POLICY_ADMIN_TOKEN"] = "test-policy-admin"
os.environ["POLICY_SERVICE_TOKEN"] = "test-policy-service"

from fastapi.testclient import TestClient
from app.main import app
from app.main import policy_repository
from app.repository import PolicyConflictError, PostgresPolicyRepository
from app.main_types import PolicyRule

client = TestClient(app)
service_headers = {"authorization": "Bearer test-policy-service"}
admin_headers = {"authorization": "Bearer test-policy-admin"}
policy_repository._rules.clear()

def test_health():
    assert client.get('/health').json()['status'] == 'ok'

def test_policy_administration_requires_token():
    response = client.get('/v1/policies')
    assert response.status_code == 401
    response = client.get('/v1/policies', headers={"authorization": "Bearer wrong"})
    assert response.status_code == 401
    response = client.get('/v1/policies', headers=admin_headers)
    assert response.status_code == 200

def test_default_deny():
    response = client.post('/v1/authorize', headers=service_headers, json={'actor_id':'a','tool_id':'t'})
    assert response.status_code == 200 and response.json() == {
        'allowed': False,
        'reason': 'No matching policy',
        'policy_id': None,
    }

def test_policy_contract_uses_snake_case_and_rejects_camel_case():
    response = client.post('/v1/policies', headers=admin_headers, json={
        'policyId': 'wrong-shape',
        'effect': 'allow',
        'toolId': 'weather',
        'reason': 'wrong shape',
    })
    assert response.status_code == 422

    response = client.post('/v1/authorize', headers=service_headers, json={
        'actorId': 'a',
        'toolId': 't',
    })
    assert response.status_code == 422

def test_authorization_requires_service_token():
    assert client.post('/v1/authorize', json={'actor_id': 'a', 'tool_id': 't'}).status_code == 401
    assert client.post(
        '/v1/authorize',
        headers={"authorization": "Bearer wrong-token"},
        json={'actor_id': 'a', 'tool_id': 't'},
    ).status_code == 401

def test_policy_allows_matching_actor_and_tool_but_denies_other_actor():
    created = client.post('/v1/policies', headers=admin_headers, json={
        'policy_id': 'demo-weather-read',
        'effect': 'allow',
        'actor_id': 'agent-2',
        'tool_id': 'weather',
        'action': 'invoke',
        'reason': 'Demo agent may invoke weather',
    })
    assert created.status_code == 201

    allowed = client.post('/v1/authorize', headers=service_headers, json={
        'actor_id': 'agent-2', 'tool_id': 'weather', 'action': 'invoke',
    })
    denied = client.post('/v1/authorize', headers=service_headers, json={
        'actor_id': 'agent-3', 'tool_id': 'weather', 'action': 'invoke',
    })
    assert allowed.json() == {
        'allowed': True,
        'reason': 'Demo agent may invoke weather',
        'policy_id': 'demo-weather-read',
    }
    assert denied.json()['allowed'] is False

def test_specific_deny_precedes_specific_allow():
    client.post('/v1/policies', headers=admin_headers, json={
        'policy_id': 'allow-tool',
        'effect': 'allow',
        'actor_id': 'agent-3',
        'tool_id': 'restricted',
        'action': 'invoke',
        'reason': 'allow',
    })
    client.post('/v1/policies', headers=admin_headers, json={
        'policy_id': 'deny-tool',
        'effect': 'deny',
        'actor_id': 'agent-3',
        'tool_id': 'restricted',
        'action': 'invoke',
        'reason': 'deny',
    })
    decision = client.post('/v1/authorize', headers=service_headers, json={
        'actor_id': 'agent-3', 'tool_id': 'restricted', 'action': 'invoke',
    })
    assert decision.json()['allowed'] is False

def test_arbitrary_audit_endpoint_is_removed():
    assert client.post('/v1/audit', json={'anything': 'accepted'}).status_code == 404

def test_concurrent_policy_conflicts_return_409(monkeypatch):
    class ConflictingRepository:
        def get(self, policy_id):
            return None

        def create(self, rule):
            raise PolicyConflictError("policy already exists")

    monkeypatch.setattr("app.main.policy_repository", ConflictingRepository())
    response = client.post('/v1/policies', headers=admin_headers, json={
        'policy_id': 'race-policy',
        'effect': 'allow',
        'tool_id': 'weather',
        'reason': 'race',
    })
    assert response.status_code == 409
    assert response.json()['detail'] == 'policy already exists'

def test_postgres_unique_violation_is_translated_and_rolled_back():
    class UniqueViolation(Exception):
        pass

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args):
            raise UniqueViolation("duplicate key")

    class Connection:
        rolled_back = False

        def cursor(self):
            return Cursor()

        def rollback(self):
            self.rolled_back = True

    repository = object.__new__(PostgresPolicyRepository)
    connection = Connection()
    repository._connection = connection
    repository._psycopg = SimpleNamespace(errors=SimpleNamespace(UniqueViolation=UniqueViolation))

    with pytest.raises(PolicyConflictError, match="policy already exists"):
        repository.create(PolicyRule(
            policy_id="race-policy",
            effect="allow",
            tool_id="weather",
            reason="race",
        ))
    assert connection.rolled_back is True
