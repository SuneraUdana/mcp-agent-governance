# MCP Agent Platform MVP

A deliberately small hybrid monorepo foundation: Fastify owns the public API and MCP gateway boundary, while FastAPI owns authorization policy decisions. PostgreSQL and Redis are provisioned for the next persistence/cache increment.

## Layout
- `apps/api`: TypeScript Fastify API, agent registry with PostgreSQL and explicit memory fallback, OpenAPI at `/docs`.
- `services/policy`: Python FastAPI policy boundary with explicit in-memory policy rules and secure default-deny.
- `services/tool`: deterministic external HTTP tool used by the local showcase.
- `demo/gradio_app.py`: Gradio client for the governed invocation flow.
- `packages/contracts/schemas/domain.json`: shared source-of-truth JSON Schema for domain contracts.
- `infra/docker-compose.yml`: PostgreSQL and Redis.
- `docs/mvp-evaluation.md`: evidence-based scope, security, performance, and readiness assessment.

## Local run
```sh
cp .env.example .env
npm install
npm run build && npm test
# configure the admin tokens in your shell (use long random values)
export ADMIN_API_TOKEN='replace-with-a-long-random-admin-token'
export POLICY_ADMIN_TOKEN='replace-with-a-long-random-policy-admin-token'
# development fallback (explicit; no database required)
AGENT_REPOSITORY=memory npm run dev:api
# PostgreSQL-backed registry
docker compose -f infra/docker-compose.yml up -d postgres redis
psql "$DATABASE_URL" -f infra/migrations/001_create_agents.sql
psql "$DATABASE_URL" -f infra/migrations/002_create_credentials.sql
psql "$DATABASE_URL" -f infra/migrations/003_create_audit_events.sql
psql "$DATABASE_URL" -f infra/migrations/004_create_policies.sql
AGENT_REPOSITORY=postgres npm run dev:api
python3 -m venv services/policy/.venv
. services/policy/.venv/bin/activate
pip install -r services/policy/requirements.txt
pytest -q services/policy/tests
uvicorn services.policy.app.main:app --reload --port 8000
# separate shell: start the external demo tool
uvicorn services.tool.app.main:app --reload --port 8010
# separate shell: npm run dev:api
# optional dependencies: docker compose -f infra/docker-compose.yml up -d
```

API health: `http://localhost:3000/health`; policy health: `http://localhost:8000/health`. Fastify `POST /v1/authorize` delegates to the policy service. It returns `503` when the policy service is unavailable and `504` on timeout. The policy service defaults to deny until a matching rule is configured.

Administrative registry and credential routes require
`Authorization: Bearer $ADMIN_API_TOKEN`. Policy list/create routes require
`Authorization: Bearer $POLICY_ADMIN_TOKEN`; both services fail closed with
`503` if their admin token is not configured and return `401` for a missing or
invalid token. Keep these tokens server-side and never use them in the Gradio
client.

For a local allow rule, start the policy service with a JSON array:

```sh
export POLICY_RULES_JSON='[{"policy_id":"demo-weather","effect":"allow","actor_id":"agent-2","tool_id":"weather","action":"invoke","reason":"Demo agent may invoke weather"}]'
uvicorn services.policy.app.main:app --reload --port 8000
```

Set `POLICY_REPOSITORY=postgres` with `DATABASE_URL` to persist policies in
PostgreSQL; the migration order is `001` through `004`. The default
`POLICY_REPOSITORY=memory` mode is process-local and can be seeded with
`POLICY_RULES_JSON`. `POST /v1/policies` and `GET /v1/policies` support
controlled demos; these administrative endpoints are not authenticated yet.
Rules match exact tool/action values and optionally an exact actor. A
specific actor match takes precedence over a wildcard actor match; within the
same specificity, deny takes precedence over allow. Unmatched requests remain
denied.

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
  -H "authorization: Bearer $ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"scope":["tools:read"],"ttlSeconds":300}'
```

The response contains the plaintext `secret` exactly once. Only its SHA-256
hash is persisted; the API never returns it again. TTL defaults to 15 minutes
and is capped at one hour. Credentials require a non-empty scope and an
active, non-expired agent.

Revoke a credential:

```sh
curl -X POST http://localhost:3000/v1/credentials/<credential-id>/revoke \
  -H "authorization: Bearer $ADMIN_API_TOKEN"
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

The boundary executes a configurable HTTP tool transport after credential and
policy checks. Set `MCP_TOOL_URL` to an external MCP-compatible gateway
endpoint; the request body contains `toolId`, `action`, `payload`, and
`correlationId`. The response JSON becomes the tool result. If unset, the API
uses a deterministic local adapter for development. Both policy denials and
downstream tool failures are audited.

Seed a complete demo flow after starting the API and policy service:

```sh
npm --workspace @mcp/api run demo:seed
```

The command creates an example agent and allow policy, issues a scoped
credential, and prints a ready-to-run invocation command. The credential
secret is printed once; treat the output as sensitive and revoke the
credential after the demo.

For the browser showcase, start the API with
`MCP_TOOL_URL=http://localhost:8010/v1/tools/invoke`, run the seed command,
then install the demo dependency and launch Gradio:

```sh
pip install -r demo/requirements.txt
DEMO_API_URL=http://localhost:3000 python demo/gradio_app.py
```

Paste the seed output values into the Gradio form. A successful invocation
shows the external tool result and correlation ID. Revoke the credential with
`POST /v1/credentials/<credential-id>/revoke`, then repeat the invocation to
demonstrate enforcement.

The final validation commands are:

```sh
npm run build && npm test
python3 -m pytest -q services/policy/tests
python3 -m json.tool packages/contracts/schemas/domain.json >/dev/null
docker compose -f infra/docker-compose.yml config >/dev/null
```

See [docs/mvp-evaluation.md](docs/mvp-evaluation.md) for the MVP evaluation,
benchmark interpretation, security assessment, readiness decision, and
recommended research roadmap.
