# MCP Agent Platform MVP

A deliberately small hybrid monorepo foundation: Fastify owns the public API and MCP gateway boundary, while FastAPI owns authorization policy decisions. PostgreSQL and Redis are provisioned for the next persistence/cache increment.

## Layout
- `apps/api`: TypeScript Fastify API, agent registry with PostgreSQL and explicit memory fallback, OpenAPI at `/docs`.
- `services/policy`: Python FastAPI policy boundary (`/v1/authorize` currently secure default-deny).
- `packages/contracts/schemas/domain.json`: shared source-of-truth JSON Schema for domain contracts.
- `infra/docker-compose.yml`: PostgreSQL and Redis.

## Local run
```sh
cp .env.example .env
npm install
npm run build && npm test
# development fallback (explicit; no database required)
AGENT_REPOSITORY=memory npm run dev:api
# PostgreSQL-backed registry
docker compose -f infra/docker-compose.yml up -d postgres redis
psql "$DATABASE_URL" -f infra/migrations/001_create_agents.sql
psql "$DATABASE_URL" -f infra/migrations/002_create_credentials.sql
psql "$DATABASE_URL" -f infra/migrations/003_create_audit_events.sql
AGENT_REPOSITORY=postgres npm run dev:api
python3 -m venv services/policy/.venv
. services/policy/.venv/bin/activate
pip install -r services/policy/requirements.txt
pytest -q services/policy/tests
uvicorn services.policy.app.main:app --reload --port 8000
# separate shell: npm run dev:api
# optional dependencies: docker compose -f infra/docker-compose.yml up -d
```

API health: `http://localhost:3000/health`; policy health: `http://localhost:8000/health`. Fastify `POST /v1/authorize` now delegates to the policy service. It returns `503` when the policy service is unavailable and `504` on timeout; policy itself defaults to deny until a policy engine is configured.

Test the integrated authorization boundary:

```sh
curl -X POST http://localhost:3000/v1/authorize \
  -H "content-type: application/json" \
  -d '{"actorId":"agent-2","toolId":"example-tool","action":"invoke"}'
```

The API maps its camelCase request to the policy service's snake_case contract and returns the policy `AuthorizationDecision`.

## Agent registry

The registry supports `POST /v1/agents`, `GET /v1/agents`, `GET /v1/agents/:id`,
`PUT /v1/agents/:id`, and `POST /v1/agents/:id/deactivate`. Create/update
requires a non-empty owner, purpose, and `riskTier` (`low`, `medium`, or
`high`). Expired agents are stored as `disabled`; active records are
automatically disabled when they expire. Disabled agents cannot be updated.

The default repository is an in-memory development fallback. PostgreSQL is
only selected when `AGENT_REPOSITORY=postgres`; it fails fast if
`DATABASE_URL` is missing.

## JIT credentials

Issue a short-lived credential for an active agent:

```sh
curl -X POST http://localhost:3000/v1/agents/agent-2/credentials \
  -H "content-type: application/json" \
  -d '{"scope":["tools:read"],"ttlSeconds":300}'
```

The response contains the plaintext `secret` exactly once. Only its SHA-256
hash is persisted; the API never returns it again. TTL defaults to 15 minutes
and is capped at one hour. Credentials require a non-empty scope and an
active, non-expired agent.

Revoke a credential:

```sh
curl -X POST http://localhost:3000/v1/credentials/<credential-id>/revoke
```

For PostgreSQL, apply `infra/migrations/002_create_credentials.sql` after the
agent migration, then `infra/migrations/003_create_audit_events.sql`. The memory fallback stores hashed secrets in process memory
and is intended only for development; issued credentials disappear on restart.

## Audit and protected MCP boundary

Authorization decisions, credential issuance/revocation, and accepted or
rejected tool invocations are recorded with a correlation ID. Records include
agent/tool/credential IDs, decision, rationale, and safe metadata; plaintext
credentials are never written to audit events.

Invoke a tool only with a valid, unexpired, non-revoked credential whose scope
contains `tool:<toolId>` or `tools:invoke`:

```sh
curl -X POST http://localhost:3000/v1/mcp/invoke \
  -H "content-type: application/json" \
  -H "authorization: Bearer <secret-returned-once>" \
  -H "x-correlation-id: demo-invocation-1" \
  -d '{"agentId":"agent-2","toolId":"example-tool","credentialId":"<credential-id>"}'
```

The boundary currently authorizes and records the invocation but does not call
an external MCP server yet. The memory audit repository is process-local;
PostgreSQL mode persists events.

The final validation commands are:

```sh
npm run build && npm test
python3 -m pytest -q services/policy/tests
python3 -m json.tool packages/contracts/schemas/domain.json >/dev/null
docker compose -f infra/docker-compose.yml config >/dev/null
```
