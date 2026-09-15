from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
def test_health():
    assert client.get('/health').json()['status'] == 'ok'
def test_default_deny():
    response = client.post('/v1/authorize', json={'actor_id':'a','tool_id':'t'})
    assert response.status_code == 200 and response.json()['allowed'] is False
