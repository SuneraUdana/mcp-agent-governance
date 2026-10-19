import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { AgentConflictError, AgentValidationError, type AgentRepository } from './registry.js';
import { createPolicyAuthorizer, PolicyServiceTimeoutError, PolicyServiceUnavailableError, type PolicyAuthorizer } from './policy-client.js';
import type { AgentInput, AuditEventType, AuditListResponse, DashboardSummary } from './types.js';
import { CredentialValidationError, type CredentialRepository } from './credentials.js';
import { randomUUID } from 'node:crypto';
import { MemoryAuditRepository, type AuditRepository } from './audit.js';
import { localToolAdapter, type ToolAdapter } from './tool-adapter.js';
import { requireAdminToken } from './admin-auth.js';

const nonEmptyString = { type: 'string', minLength: 1 } as const;
const agentBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'ownerId', 'purpose', 'riskTier'],
  properties: {
    id: { ...nonEmptyString, maxLength: 100 },
    name: { ...nonEmptyString, maxLength: 200 },
    ownerId: { ...nonEmptyString, maxLength: 100 },
    purpose: { ...nonEmptyString, maxLength: 1000 },
    riskTier: { type: 'string', enum: ['low', 'medium', 'high'] },
    expiresAt: { type: 'string' },
  },
} as const;
const agentUpdateBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'ownerId', 'purpose', 'riskTier'],
  properties: {
    name: { ...nonEmptyString, maxLength: 200 },
    ownerId: { ...nonEmptyString, maxLength: 100 },
    purpose: { ...nonEmptyString, maxLength: 1000 },
    riskTier: { type: 'string', enum: ['low', 'medium', 'high'] },
    expiresAt: { type: 'string' },
  },
} as const;
const credentialBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: {
    scope: { type: 'array', minItems: 1, maxItems: 20, items: nonEmptyString },
    ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
  },
} as const;
const invocationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'toolId', 'credentialId'],
  properties: {
    agentId: nonEmptyString,
    toolId: nonEmptyString,
    credentialId: nonEmptyString,
    action: nonEmptyString,
    payload: { type: 'object', additionalProperties: true },
  },
} as const;
const authorizationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['actorId', 'toolId'],
  properties: {
    actorId: nonEmptyString,
    toolId: nonEmptyString,
    action: nonEmptyString,
    context: { type: 'object', additionalProperties: true },
  },
} as const;
const auditEventTypes = ['authorization', 'credential_issued', 'credential_revoked', 'tool_invocation'] as const;
const auditQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$', default: '50' },
    eventType: { type: 'string', enum: auditEventTypes },
  },
} as const;
const auditEventResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'correlationId', 'eventType', 'occurredAt', 'rationale', 'metadata'],
  properties: {
    id: nonEmptyString,
    correlationId: nonEmptyString,
    eventType: { type: 'string', enum: auditEventTypes },
    occurredAt: { type: 'string', format: 'date-time' },
    actorId: { type: 'string' },
    agentId: { type: 'string' },
    toolId: { type: 'string' },
    credentialId: { type: 'string' },
    allowed: { type: 'boolean' },
    rationale: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
  },
} as const;
const auditListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['events', 'total'],
  properties: {
    events: { type: 'array', items: auditEventResponseSchema },
    total: { type: 'integer', minimum: 0 },
  },
} as const;
const dashboardSummaryResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['generatedAt', 'agents', 'audit', 'recentEvents'],
  properties: {
    generatedAt: { type: 'string', format: 'date-time' },
    agents: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'active', 'disabled', 'byRiskTier'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        active: { type: 'integer', minimum: 0 },
        disabled: { type: 'integer', minimum: 0 },
        byRiskTier: {
          type: 'object',
          additionalProperties: false,
          required: ['low', 'medium', 'high'],
          properties: {
            low: { type: 'integer', minimum: 0 },
            medium: { type: 'integer', minimum: 0 },
            high: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    audit: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'allowed', 'denied', 'byEventType'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        allowed: { type: 'integer', minimum: 0 },
        denied: { type: 'integer', minimum: 0 },
        byEventType: {
          type: 'object',
          additionalProperties: false,
          required: auditEventTypes,
          properties: Object.fromEntries(auditEventTypes.map((type) => [type, { type: 'integer', minimum: 0 }])),
        },
      },
    },
    recentEvents: { type: 'array', items: auditEventResponseSchema },
  },
} as const;

export function buildApp(repository: AgentRepository, authorize: PolicyAuthorizer = createPolicyAuthorizer(), credentials?: CredentialRepository, audit: AuditRepository = new MemoryAuditRepository(), invokeTool: ToolAdapter = localToolAdapter, adminToken = process.env.ADMIN_API_TOKEN): FastifyInstance {
  const app = Fastify({ logger: true, ajv: { customOptions: { coerceTypes: false } } });
  app.register(swagger, { openapi: { info: { title: 'MCP Agent API', version: '0.1.0' } } });
  app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/agents') && !request.url.startsWith('/v1/credentials') && !request.url.startsWith('/v1/dashboard') && !request.url.startsWith('/v1/audit')) return;
    const failure = requireAdminToken(request, adminToken);
    if (failure) return reply.code(failure.statusCode).send({ error: failure.error });
  });
  app.get('/v1/agents', async () => repository.list());
  app.post<{ Body: AgentInput }>('/v1/agents', { schema: { body: agentBodySchema } }, async (request, reply) => {
    try { return reply.code(201).send(await repository.create(request.body)); }
    catch (error) { return handleRegistryError(error, reply); }
  });
  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    const agent = await repository.get(request.params.id);
    return agent ? agent : reply.code(404).send({ error: 'agent not found' });
  });
  app.put<{ Params: { id: string }; Body: Omit<AgentInput, 'id'> }>('/v1/agents/:id', { schema: { body: agentUpdateBodySchema } }, async (request, reply) => {
    try {
      const agent = await repository.update(request.params.id, request.body);
      return agent ? agent : reply.code(404).send({ error: 'agent not found or already disabled' });
    } catch (error) { return handleRegistryError(error, reply); }
  });
  app.post<{ Params: { id: string } }>('/v1/agents/:id/deactivate', async (request, reply) => {
    const agent = await repository.deactivate(request.params.id);
    return agent ? agent : reply.code(404).send({ error: 'agent not found' });
  });
  app.post<{ Params: { id: string }; Body: { scope: string[]; ttlSeconds?: number } }>('/v1/agents/:id/credentials', { schema: { body: credentialBodySchema } }, async (request, reply) => {
    const credentialRepository = credentials;
    if (!credentialRepository) return reply.code(503).send({ error: 'credential service is not configured' });
    try {
      const issued = await credentialRepository.issue({ agentId: request.params.id, ...request.body });
      await audit.record({ correlationId: correlationId(request.headers['x-correlation-id']), eventType: 'credential_issued', agentId: request.params.id, credentialId: issued.id, rationale: 'JIT credential issued', metadata: { scope: issued.scope, expiresAt: issued.expiresAt } });
      return reply.code(201).send(issued);
    } catch (error) {
      if (error instanceof CredentialValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });
  app.post<{ Params: { id: string } }>('/v1/credentials/:id/revoke', async (request, reply) => {
    if (!credentials) return reply.code(503).send({ error: 'credential service is not configured' });
    const revoked = await credentials.revoke(request.params.id);
    if (revoked) await audit.record({ correlationId: correlationId(request.headers['x-correlation-id']), eventType: 'credential_revoked', agentId: revoked.agentId, credentialId: revoked.id, rationale: 'Credential revoked', metadata: {} });
    return revoked ? reply.send(revoked) : reply.code(404).send({ error: 'credential not found' });
  });
  app.post<{ Body: { agentId: string; toolId: string; credentialId: string; action?: string; payload?: Record<string, unknown> } }>('/v1/mcp/invoke', { schema: { body: invocationBodySchema } }, async (request, reply) => {
    if (!credentials) return reply.code(503).send({ error: 'credential service is not configured' });
    const correlation = correlationId(request.headers['x-correlation-id']);
    const secret = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const requiredScope = `tool:${request.body?.toolId ?? ''}`;
    try {
      if (!request.body?.agentId || !request.body?.toolId || !request.body?.credentialId || !secret) {
        return reply.code(400).send({ error: 'agentId, toolId, credentialId, and bearer credential are required' });
      }
      await credentials.verify(request.body.credentialId, secret, request.body.agentId, requiredScope);
      const decision = await authorize({ actorId: request.body.agentId, toolId: request.body.toolId, action: request.body.action ?? 'invoke', context: { correlationId: correlation } });
      await audit.record({ correlationId: correlation, eventType: 'authorization', actorId: request.body.agentId, agentId: request.body.agentId, toolId: request.body.toolId, credentialId: request.body.credentialId, allowed: decision.allowed, rationale: decision.reason, metadata: { policyId: decision.policyId } });
      if (!decision.allowed) {
        await audit.record({ correlationId: correlation, eventType: 'tool_invocation', actorId: request.body.agentId, agentId: request.body.agentId, toolId: request.body.toolId, credentialId: request.body.credentialId, allowed: false, rationale: decision.reason, metadata: { policyId: decision.policyId } });
        return reply.code(403).send({ error: 'invocation denied', reason: decision.reason, correlationId: correlation });
      }
      try {
        const result = await invokeTool({
          toolId: request.body.toolId,
          action: request.body.action ?? 'invoke',
          payload: request.body.payload ?? {},
          correlationId: correlation,
        });
        try {
          await audit.record({ correlationId: correlation, eventType: 'tool_invocation', actorId: request.body.agentId, agentId: request.body.agentId, toolId: request.body.toolId, credentialId: request.body.credentialId, allowed: true, rationale: 'Policy authorized and tool executed', metadata: { policyId: decision.policyId } });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'audit recording failed';
          return reply.code(500).send({ error: 'tool executed but audit recording failed', reason, correlationId: correlation, toolExecuted: true });
        }
        return reply.send({ accepted: true, correlationId: correlation, decision, result });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'tool invocation failed';
        await audit.record({ correlationId: correlation, eventType: 'tool_invocation', actorId: request.body.agentId, agentId: request.body.agentId, toolId: request.body.toolId, credentialId: request.body.credentialId, allowed: false, rationale: reason, metadata: { policyId: decision.policyId } });
        return reply.code(502).send({ error: 'tool invocation failed', reason, correlationId: correlation });
      }
    } catch (error) {
      if (error instanceof CredentialValidationError) {
        await audit.record({ correlationId: correlation, eventType: 'authorization', actorId: request.body?.agentId, agentId: request.body?.agentId, toolId: request.body?.toolId, credentialId: request.body?.credentialId, allowed: false, rationale: error.message, metadata: {} });
        return reply.code(401).send({ error: error.message, correlationId: correlation });
      }
      throw error;
    }
  });
  app.post<{ Body: { actorId: string; toolId: string; action?: string; context?: Record<string, unknown> } }>('/v1/authorize', { schema: { body: authorizationBodySchema } }, async (request, reply) => {
    if (!request.body?.actorId || !request.body?.toolId) {
      return reply.code(400).send({ error: 'actorId and toolId are required' });
    }
    try {
      const decision = await authorize(request.body);
      await audit.record({ correlationId: correlationId(request.headers['x-correlation-id']), eventType: 'authorization', actorId: request.body.actorId, toolId: request.body.toolId, allowed: decision.allowed, rationale: decision.reason, metadata: { policyId: decision.policyId } });
      return reply.send(decision);
    } catch (error) {
      if (error instanceof PolicyServiceTimeoutError) return reply.code(504).send({ error: error.message });
      if (error instanceof PolicyServiceUnavailableError) return reply.code(503).send({ error: error.message });
      throw error;
    }

  });
  app.get<{ Querystring: { limit?: string; eventType?: AuditEventType }; Reply: AuditListResponse }>('/v1/audit', { schema: { querystring: auditQuerySchema, response: { 200: auditListResponseSchema } } }, async (request) => {
    const allEvents = await audit.list();
    const filtered = request.query.eventType ? allEvents.filter((event) => event.eventType === request.query.eventType) : allEvents;
    const events = filtered.slice().sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, Number(request.query.limit ?? 50)).map(publicAuditEvent);
    return { events, total: filtered.length };
  });
  app.get<{ Reply: DashboardSummary }>('/v1/dashboard/summary', { schema: { response: { 200: dashboardSummaryResponseSchema } } }, async () => {
    const [agents, auditEvents] = await Promise.all([repository.list(), audit.list()]);
    const summary: DashboardSummary = {
      generatedAt: new Date().toISOString(),
      agents: {
        total: agents.length,
        active: agents.filter((agent) => agent.status === 'active').length,
        disabled: agents.filter((agent) => agent.status === 'disabled').length,
        byRiskTier: {
          low: agents.filter((agent) => agent.riskTier === 'low').length,
          medium: agents.filter((agent) => agent.riskTier === 'medium').length,
          high: agents.filter((agent) => agent.riskTier === 'high').length,
        },
      },
      audit: {
        total: auditEvents.length,
        allowed: auditEvents.filter((event) => event.allowed === true).length,
        denied: auditEvents.filter((event) => event.allowed === false).length,
        byEventType: Object.fromEntries(auditEventTypes.map((type) => [type, auditEvents.filter((event) => event.eventType === type).length])) as DashboardSummary['audit']['byEventType'],
      },
      recentEvents: auditEvents.slice().sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 10).map(publicAuditEvent),
    };
    return summary;
  });
  return app;
}

function publicAuditEvent(event: Awaited<ReturnType<AuditRepository['list']>>[number]) {
  return {
    ...event,
    metadata: redactSensitiveMetadata(event.metadata),
  };
}

function redactSensitiveMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => {
    if (/(secret|token|password|credential)/i.test(key)) return [key, '[REDACTED]'];
    if (Array.isArray(value)) return [key, value.map((item) => typeof item === 'object' && item !== null ? redactSensitiveMetadata(item as Record<string, unknown>) : item)];
    if (typeof value === 'object' && value !== null) return [key, redactSensitiveMetadata(value as Record<string, unknown>)];
    return [key, value];
  }));
}

function correlationId(value: string | string[] | undefined): string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 ? value : randomUUID();
}

function handleRegistryError(error: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  if (error instanceof AgentValidationError) return reply.code(400).send({ error: error.message });
  if (error instanceof AgentConflictError) return reply.code(409).send({ error: error.message });
  throw error;
}
