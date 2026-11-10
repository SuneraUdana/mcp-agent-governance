# MVP architecture

The MVP uses a split service boundary:

```text
Client
  |
  v
Operator dashboard (:5173, dev proxy)
  |
  v
Fastify API (:3000)
  |-- Agent registry (in-memory for this slice)
  |-- Authenticated operator read models (/v1/dashboard/*, /v1/audit, /v1/policies)
  |-- MCP gateway boundary (/v1/mcp/invoke)
  `-- Authorization boundary (/v1/authorize)
          |
          v
    FastAPI policy service (:8000)
      `-- Authenticated default-deny authorization

PostgreSQL (:5432) and Redis (:6379) are provisioned for the next
persistence and caching increment.
```

## Contract ownership

`packages/contracts/schemas/domain.json` is the shared JSON Schema source of
truth for the domain payloads. The API has lightweight TypeScript aliases for
the first vertical slice, while the policy service uses Pydantic request and
response models at its HTTP boundary.

The initial domain entities are:

- **Agent**: a registered AI agent and its lifecycle status.
- **Owner**: the human or organization responsible for an agent.
- **Credential**: a reference to an external secret, never the secret itself.
- **Policy**: an allow/deny rule that can target tools.
- **Tool**: an MCP tool and the server that exposes it.
- **AuthorizationDecision**: the policy outcome and explanation.
- **AuditEvent**: an immutable record of an authorization or tool action.

The registry and policy decisions are intentionally in-memory/default-deny in
this slice. The external tool boundary uses a minimal Streamable HTTP MCP
client behind `ToolAdapter`: it negotiates a session with `initialize`, sends
the initialization notification, then calls `tools/call`. The adapter retains
the session, retries once after a session-invalidating `400`/`404`, and
normalizes protocol, malformed-response, timeout, and transport failures into
explicit tool errors. The local adapter remains deterministic and bypasses
network transport.

The Fastify-to-policy authorization call uses a dedicated bearer token from
`POLICY_SERVICE_TOKEN`. The policy service does not expose a generic audit
ingestion endpoint; audit records are created by the Fastify API from
validated internal events.

The operator dashboard uses TanStack Query for API state and Recharts for its
risk overview. The development proxy injects `ADMIN_API_TOKEN` server-side so
credentials never enter browser bundles. Production deployments should put
the equivalent authentication in a reverse proxy or backend-for-frontend. The
dashboard reads agent details, policies, simulation decisions, filtered audit
events, and dependency health from authenticated API routes. It uses bounded
polling for freshness; SSE/WebSocket delivery, alerting, and push fan-out are
explicitly deferred.

## Read-only operator surfaces

Fastify owns the operator read model and authenticates every route with the
administrative bearer token. Agent detail correlates registry identity,
identity metadata, matching policy targets, and audit events by `agentId`.
Policy simulation calls the same policy authorizer used by the MCP boundary,
so the rationale shown in the UI is not a client-side prediction. Policy
listing uses a separate server-side policy-admin token and returns only
validated policy metadata. No route returns credential plaintext or accepts
arbitrary audit writes.

## Policy contract

The policy service owns a snake_case wire contract for policy rules and
authorization requests/responses (`policy_id`, `actor_id`, `tool_id`, and
`context`). Fastify's public API remains camelCase (`actorId`, `toolId`,
`policyId`); `policy-client.ts` is the explicit transport adapter between
those shapes. Responses always include `policy_id` as either a string or
`null`, including default-deny decisions.
