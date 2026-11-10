# Shared contracts

`schemas/domain.json` is the source of truth for MVP domain payloads. Both services expose/use these shapes; generated code can be added later without changing API semantics.

The policy-service wire contract is deliberately snake_case: `Policy`,
`AuthorizationRequest`, and `AuthorizationDecision` use names such as
`policy_id`, `actor_id`, `tool_id`, and `policy_id`. The Fastify API keeps its
public and internal TypeScript models in camelCase and performs this mapping in
`apps/api/src/policy-client.ts`; it does not send a second camelCase policy
wire format.
