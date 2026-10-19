# MVP evaluation

## Executive assessment

The project is a **technically complete MVP prototype** for agent identity,
short-lived credentials, configurable policy authorization, and audit boundaries. It is
useful for local development, architecture demonstrations, and a Gradio
showcase. It is **not production-ready** because a standards-complete MCP
transport, production observability, rate limiting, and operational controls
are not implemented yet.

This assessment is based on the repository state after the initial vertical
slices and the validation and benchmark commands documented below.

## Scope and objectives

The MVP evaluates whether the platform can:

- register and manage agents with owner, purpose, risk tier, lifecycle, and
  expiry rules;
- issue short-lived credentials for active agents and requested scopes;
- prevent use of expired, revoked, misbound, malformed, or insufficiently
  scoped credentials;
- delegate authorization decisions to the Python policy boundary;
- record authorization, credential, and tool-decision events with correlation
  IDs without persisting plaintext secrets; and
- run locally with either explicit in-memory development repositories or
  PostgreSQL-backed repositories.

## Architecture and trust boundaries

| Boundary | Responsibility | Evaluation |
| --- | --- | --- |
| Fastify API | Public API, registry lifecycle, credential checks, MCP boundary, audit writes | Implemented and covered by API tests |
| FastAPI policy service | Authorization decision contract | Implemented with secure default-deny behavior |
| PostgreSQL | Durable agents, credentials, policies, and audit events | Migrations and repository paths implemented and persistence smoke-tested |
| Redis | Provisioned infrastructure for a future cache/use case | Not used by the current vertical slice |
| Shared JSON Schema | Cross-service domain contract | Parses successfully and reflects current credential/audit shapes |

The client must trust the Fastify API as the enforcement point. The Fastify
API must trust the policy service only for the policy decision, not for
credential validity. Credential hash, agent binding, expiry, revocation, and
scope checks happen before the protected MCP boundary requests authorization.

## Functional evidence

| Area | Evidence | Result |
| --- | --- | --- |
| Agent registry | Create, get, list, update, deactivate; validation for owner, purpose, risk tier, expiry, duplicates, and lifecycle | Passed |
| Credential issuance | Active-agent binding, non-empty scopes, default 15-minute TTL, one-hour maximum TTL, hash-only persistence | Passed |
| Credential enforcement | Expiry, revocation, wrong-agent binding, malformed bearer, and insufficient scope checks | Passed |
| Authorization | Fastify-to-FastAPI mapping, decision normalization, timeout and unavailable-service handling | Passed |
| Audit | Authorization, issuance, revocation, and invocation events with correlation ID and safe metadata | Passed |
| Persistence | PostgreSQL migrations for agents, credentials, policies, and audit events; explicit memory fallback | Migration and restart-persistence validation passed |

The API suite contains twelve focused tests, including security edge cases. The
policy service suite contains five tests covering health, default-deny behavior,
policy precedence, and administrative authentication.

## Security assessment

### Strengths

- Credential secrets are generated with cryptographically secure random bytes.
- Only SHA-256 credential hashes are persisted; the plaintext secret is
  returned only during issuance.
- Credentials are short-lived, scope-bound, agent-bound, and revocable.
- Protected invocation rejects malformed, expired, revoked, misbound, and
  insufficiently scoped credentials.
- The policy service defaults to deny when no policy is configured.
- Audit metadata excludes plaintext credentials.
- Correlation IDs are accepted from the request with a bounded length, or
  generated when absent.
- Administrative registry and credential routes require a configured bearer
  token, and policy administration has a separate bearer token.
- Credential hash verification uses a length-safe constant-time comparison.

### Remaining risks

- Administrative authentication currently uses static bearer tokens rather than
  a full identity provider, role model, or token rotation workflow.
- Memory policy rules are process-local. PostgreSQL mode persists active rules
  with version and status fields; unmatched requests remain denied.
- Rate limiting, abuse detection, key rotation, and owner identity
  verification are not implemented.
- The in-memory repository is process-local and must not be used for
  production data.
- Previously exposed demo tokens must remain revoked and must never be reused.

## Performance evidence

The local benchmark used `autocannon` for 15 seconds with 10 connections.
These are development-mode, single-machine measurements and should not be
treated as capacity guarantees.

| Operation | Average latency | Throughput |
| --- | ---: | ---: |
| `GET /health` in-memory API | 0.01 ms | ~38,275 req/s |
| `GET /v1/agents` with 100 agents | 0.06 ms | ~11,877 req/s |
| Credential issuance in memory | 0.06 ms | ~19,606 req/s |
| Direct FastAPI authorization | 1.19 ms | ~5,801 req/s |
| Integrated Fastify authorization | 1.84 ms | ~4,205 req/s |
| Protected MCP governance boundary | 1.79 ms | ~4,285 req/s |

The PostgreSQL-backed rerun used Docker PostgreSQL and Redis, migrations
001–004, `AGENT_REPOSITORY=postgres`, 101 seeded agents, and the same 15-second
duration with 10 connections:

| Operation | Average latency | P99 latency | Throughput | Result |
| --- | ---: | ---: | ---: | --- |
| `GET /health` | 0.01 ms | 0 ms | 29,838.94 req/s | 447,576 x 200 |
| `GET /v1/agents` with 101 PostgreSQL agents | 5.47 ms | 10 ms | 1,675.47 req/s | 25,132 x 200 |
| Credential issuance with PostgreSQL | 3.89 ms | 7 ms | 2,281.00 req/s | 34,209 x 201 |
| Direct FastAPI authorization | 1.69 ms | 3 ms | 4,636.14 req/s | 69,532 x 200 |
| Integrated Fastify authorization | 4.28 ms | 8 ms | 2,094.00 req/s | 31,404 x 200 |
| Protected MCP governance boundary | 5.92 ms | 11 ms | 1,557.67 req/s | 23,365 x 200 |

All corrected PostgreSQL benchmark scenarios completed with zero transport
errors and zero timeouts. An initial protected-MCP attempt used malformed
autocannon header syntax and produced 106,895 HTTP 400 responses; a direct
`curl` request confirmed the application path, the command was corrected, and
the final run above passed. Benchmark data, credentials, audit records,
processes, and containers were removed afterward. These remain development
single-machine measurements, not capacity guarantees; production evaluation
should add database resource metrics and broader concurrent workloads.

## Reliability and operability

The API exposes health endpoints and maps policy-service failure to explicit
`503` unavailable or `504` timeout responses. PostgreSQL migrations are ordered
and can be applied independently. The remaining operational gaps are:

- no metrics, tracing, or centralized structured-log sink;
- no audit query or retention API;
- no backup/restore or migration rollback procedure;
- no load test against an external MCP server; and
- no production deployment configuration.

## Readiness decision

| Readiness level | Decision | Reason |
| --- | --- | --- |
| Local prototype | **Ready** | Core flows, tests, schema checks, and local startup are documented |
| Demo/pilot evaluation | **Ready with limitations** | Suitable for a controlled showcase using non-production credentials |
| Production deployment | **Not ready** | Missing standards-complete MCP integration, observability, rate limiting, token rotation, and operational controls |

## Recommended next research

1. Replace the demo HTTP adapter with a standards-complete MCP transport and
   measure end-to-end tool latency.
2. Add rate limiting, key rotation, and owner identity validation.
3. Add authenticated audit search, retention, and tamper-evidence controls.
4. Repeat benchmarks with PostgreSQL and realistic concurrent workloads.
5. Add CI for TypeScript, Python, schema, migrations, dependency audits, and
   security regression tests.
6. Deploy the API over HTTPS before building the Gradio Space integration.

## Reproduction commands

```sh
npm run build
npm test
(cd services/policy && python3 -m pytest -q tests)
(cd services/tool && python3 -m pytest -q tests)
python3 -m json.tool packages/contracts/schemas/domain.json >/dev/null
docker compose -f infra/docker-compose.yml config >/dev/null
npm audit --omit=dev --audit-level=high
```

For the complete local startup and API walkthrough, see the
[README](../README.md).
