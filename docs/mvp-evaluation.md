# MVP evaluation

## Executive assessment

The project is a **technically complete MVP prototype** for agent identity,
short-lived credentials, configurable policy authorization, and audit boundaries. It is
useful for local development, architecture demonstrations, and a Gradio
showcase. It is **not production-ready** because administrative
authentication, persisted policy storage, a standards-complete MCP transport,
production observability are not implemented yet.

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
| PostgreSQL | Durable agents, credentials, policies, and audit events | Migrations and repository paths implemented |
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
| Persistence | PostgreSQL migrations for agents, credentials, and audit events; explicit memory fallback | Migration validation passed |

The API suite contains seven focused tests, including security edge cases. The
policy service suite contains two tests for health and default-deny behavior.

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

### Remaining risks

- Administrative endpoints are not protected by an administrator identity or
  role model.
- Memory policy rules are process-local. PostgreSQL mode persists active rules
  with version and status fields; unmatched requests remain denied.
- Constant-time secret comparison should be used for production-grade
  verification.
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

The protected MCP benchmark returned non-2xx responses because the policy
service was intentionally default-deny. Credential validation completed before
the policy denial, so this measures governance overhead rather than an actual
tool call.

PostgreSQL-backed performance was not measured in the latest run because the
Docker daemon was unavailable. A production evaluation must repeat the same
scenarios with PostgreSQL enabled and record database resource usage, error
rates, and latency percentiles.

## Reliability and operability

The API exposes health endpoints and maps policy-service failure to explicit
`503` unavailable or `504` timeout responses. PostgreSQL migrations are ordered
and can be applied independently. The remaining operational gaps are:

- no CI workflow yet;
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
| Production deployment | **Not ready** | Missing persisted policy management, admin authentication, standards-complete MCP integration, observability, and operational controls |

## Recommended next research

1. Protect policy administration with an authenticated owner/admin boundary.
2. Replace the demo HTTP adapter with a standards-complete MCP transport and
   measure end-to-end tool latency.
3. Add administrator authentication, rate limiting, constant-time comparisons,
   key rotation, and owner identity validation.
4. Add authenticated audit search, retention, and tamper-evidence controls.
5. Repeat benchmarks with PostgreSQL and realistic concurrent workloads.
6. Add CI for TypeScript, Python, schema, migrations, dependency audits, and
   security regression tests.
7. Deploy the API over HTTPS before building the Gradio Space integration.

## Reproduction commands

```sh
npm run build
npm test
python3 -m pytest -q services/policy/tests
python3 -m json.tool packages/contracts/schemas/domain.json >/dev/null
docker compose -f infra/docker-compose.yml config >/dev/null
```

For the complete local startup and API walkthrough, see the
[README](../README.md).
