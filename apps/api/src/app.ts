import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { AgentConflictError, AgentValidationError, type AgentRepository } from './registry.js';
import { createPolicyAuthorizer, PolicyServiceTimeoutError, PolicyServiceUnavailableError, type PolicyAuthorizer } from './policy-client.js';
import type { AgentInput } from './types.js';
import { CredentialValidationError, type CredentialRepository } from './credentials.js';
import { randomUUID } from 'node:crypto';
import { MemoryAuditRepository, type AuditRepository } from './audit.js';
import { localToolAdapter, type ToolAdapter } from './tool-adapter.js';

export function buildApp(repository: AgentRepository, authorize: PolicyAuthorizer = createPolicyAuthorizer(), credentials?: CredentialRepository, audit: AuditRepository = new MemoryAuditRepository(), invokeTool: ToolAdapter = localToolAdapter): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(swagger, { openapi: { info: { title: 'MCP Agent API', version: '0.1.0' } } });
  app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  app.get('/v1/agents', async () => repository.list());
  app.post<{ Body: AgentInput }>('/v1/agents', async (request, reply) => {
    try { return reply.code(201).send(await repository.create(request.body)); }
    catch (error) { return handleRegistryError(error, reply); }
  });
  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    const agent = await repository.get(request.params.id);
    return agent ? agent : reply.code(404).send({ error: 'agent not found' });
  });
  app.put<{ Params: { id: string }; Body: Omit<AgentInput, 'id'> }>('/v1/agents/:id', async (request, reply) => {
    try {
      const agent = await repository.update(request.params.id, request.body);
      return agent ? agent : reply.code(404).send({ error: 'agent not found or already disabled' });
    } catch (error) { return handleRegistryError(error, reply); }
  });
  app.post<{ Params: { id: string } }>('/v1/agents/:id/deactivate', async (request, reply) => {
    const agent = await repository.deactivate(request.params.id);
    return agent ? agent : reply.code(404).send({ error: 'agent not found' });
  });
  app.post<{ Params: { id: string }; Body: { scope: string[]; ttlSeconds?: number } }>('/v1/agents/:id/credentials', async (request, reply) => {
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
  app.post<{ Body: { agentId: string; toolId: string; credentialId: string; action?: string; payload?: Record<string, unknown> } }>('/v1/mcp/invoke', async (request, reply) => {
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
        await audit.record({ correlationId: correlation, eventType: 'tool_invocation', actorId: request.body.agentId, agentId: request.body.agentId, toolId: request.body.toolId, credentialId: request.body.credentialId, allowed: true, rationale: 'Policy authorized and tool executed', metadata: { policyId: decision.policyId } });
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
  app.post<{ Body: { actorId: string; toolId: string; action?: string; context?: Record<string, unknown> } }>('/v1/authorize', async (request, reply) => {
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
  return app;
}

function correlationId(value: string | string[] | undefined): string {
  return typeof value === 'string' && value.length <= 128 ? value : randomUUID();
}

function handleRegistryError(error: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  if (error instanceof AgentValidationError) return reply.code(400).send({ error: error.message });
  if (error instanceof AgentConflictError) return reply.code(409).send({ error: error.message });
  throw error;
}
