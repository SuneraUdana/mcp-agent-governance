# MVP architecture

The MVP uses a split service boundary:

```text
Client
  |
  v
Fastify API (:3000)
  |-- Agent registry (in-memory for this slice)
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
this slice. Persistence, credential resolution, MCP transport, and a real
policy evaluator should be added behind the existing boundaries.

The Fastify-to-policy authorization call uses a dedicated bearer token from
`POLICY_SERVICE_TOKEN`. The policy service does not expose a generic audit
ingestion endpoint; audit records are created by the Fastify API from
validated internal events.

## Policy contract

The policy service owns a snake_case wire contract for policy rules and
authorization requests/responses (`policy_id`, `actor_id`, `tool_id`, and
`context`). Fastify's public API remains camelCase (`actorId`, `toolId`,
`policyId`); `policy-client.ts` is the explicit transport adapter between
those shapes. Responses always include `policy_id` as either a string or
`null`, including default-deny decisions.
