from fastapi.testclient import TestClient
from app.main import app
from app.main import policy_rules

client = TestClient(app)
policy_rules.clear()

def test_health():
    assert client.get('/health').json()['status'] == 'ok'
def test_default_deny():
    response = client.post('/v1/authorize', json={'actor_id':'a','tool_id':'t'})
    assert response.status_code == 200 and response.json() == {
        'allowed': False,
        'reason': 'No matching policy',
        'policy_id': None,
    }

def test_policy_allows_matching_actor_and_tool_but_denies_other_actor():
    created = client.post('/v1/policies', json={
        'policy_id': 'demo-weather-read',
        'effect': 'allow',
        'actor_id': 'agent-2',
        'tool_id': 'weather',
        'action': 'invoke',
        'reason': 'Demo agent may invoke weather',
    })
    assert created.status_code == 201

    allowed = client.post('/v1/authorize', json={
        'actor_id': 'agent-2', 'tool_id': 'weather', 'action': 'invoke',
    })
    denied = client.post('/v1/authorize', json={
        'actor_id': 'agent-3', 'tool_id': 'weather', 'action': 'invoke',
    })
    assert allowed.json() == {
        'allowed': True,
        'reason': 'Demo agent may invoke weather',
        'policy_id': 'demo-weather-read',
    }
    assert denied.json()['allowed'] is False
