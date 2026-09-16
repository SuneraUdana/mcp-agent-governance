import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { MemoryAgentRepository } from './registry.js';
import { MemoryCredentialRepository } from './credentials.js';
import { MemoryAuditRepository } from './audit.js';
import { hashesMatch } from './credentials.js';

const adminHeaders = { authorization: 'Bearer test-admin' };

test('credential hash comparison is exact and length-safe', () => {
  assert.equal(hashesMatch('abc', 'abc'), true);
  assert.equal(hashesMatch('abc', 'abd'), false);
  assert.equal(hashesMatch('abc', 'ab'), false);
});

test('administrative routes reject missing and invalid tokens', async () => {
  const app = buildApp(new MemoryAgentRepository(), undefined, undefined, new MemoryAuditRepository(), undefined, 'test-admin');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/agents' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/agents', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/agents', headers: adminHeaders })).statusCode, 200);
  await app.close();
});

test('agent registry supports lifecycle and expiry rules', async () => {
  const agents = new MemoryAgentRepository();
  const app = buildApp(agents, undefined, new MemoryCredentialRepository(agents), new MemoryAuditRepository(), undefined, 'test-admin');
  assert.deepEqual((await app.inject('/health')).json(), { status: 'ok', service: 'api' });
  const created = await app.inject({ method: 'POST', url: '/v1/agents', headers: adminHeaders, payload: { id: 'a1', name: 'Demo', ownerId: 'o1', purpose: 'Testing', riskTier: 'low' } });
  assert.equal(created.statusCode, 201);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/agents/a1', headers: adminHeaders })).json().status, 'active');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/agents', headers: adminHeaders })).json().length, 1);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/agents/a1', headers: adminHeaders, payload: { name: 'Updated', ownerId: 'o1', purpose: 'Testing safely', riskTier: 'medium' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents/a1/deactivate', headers: adminHeaders })).json().status, 'disabled');
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/agents/a1', headers: adminHeaders, payload: { name: 'Updated', ownerId: 'o1', purpose: 'Testing safely', riskTier: 'medium' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents', headers: adminHeaders, payload: { id: 'expired', name: 'Expired', ownerId: 'o1', purpose: 'Testing', riskTier: 'high', expiresAt: '2020-01-01T00:00:00Z' } })).json().status, 'disabled');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents', headers: adminHeaders, payload: { id: 'bad', name: 'No purpose', ownerId: 'o1', riskTier: 'low' } })).statusCode, 400);
  await app.close();
});

test('duplicate agents and invalid risk tiers are rejected', async () => {
  const agents = new MemoryAgentRepository();
  const app = buildApp(agents, undefined, new MemoryCredentialRepository(agents), new MemoryAuditRepository(), undefined, 'test-admin');
  const payload = { id: 'a1', name: 'Demo', ownerId: 'o1', purpose: 'Testing', riskTier: 'low' };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents', headers: adminHeaders, payload })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents', headers: adminHeaders, payload })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents', headers: adminHeaders, payload: { ...payload, id: 'a2', riskTier: 'critical' } })).statusCode, 400);
  await app.close();
});

test('authorization delegates to policy service and returns its decision', async () => {
  const app = buildApp(new MemoryAgentRepository(), async (request) => ({
    allowed: false,
    reason: `Denied ${request.actorId} for ${request.toolId}`,
    policyId: 'policy-1',
  }), new MemoryCredentialRepository(new MemoryAgentRepository()), new MemoryAuditRepository(), undefined, 'test-admin');
  const response = await app.inject({
    method: 'POST',
    url: '/v1/authorize',
    payload: { actorId: 'agent-2', toolId: 'tool-1', action: 'invoke' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { allowed: false, reason: 'Denied agent-2 for tool-1', policyId: 'policy-1' });
  await app.close();
});

test('authorization validates input and surfaces policy outages', async () => {
  const unavailable = buildApp(new MemoryAgentRepository(), async () => {
    throw new Error('unexpected outage');
  }, new MemoryCredentialRepository(new MemoryAgentRepository()), new MemoryAuditRepository(), undefined, 'test-admin');
  assert.equal((await unavailable.inject({ method: 'POST', url: '/v1/authorize', payload: { toolId: 'tool-1' } })).statusCode, 400);
  assert.equal((await unavailable.inject({ method: 'POST', url: '/v1/authorize', payload: { actorId: 'agent-1', toolId: 'tool-1' } })).statusCode, 500);
  await unavailable.close();

  const timeout = buildApp(new MemoryAgentRepository(), async () => {
    const { PolicyServiceTimeoutError } = await import('./policy-client.js');
    throw new PolicyServiceTimeoutError('timed out');
  }, new MemoryCredentialRepository(new MemoryAgentRepository()), new MemoryAuditRepository(), undefined, 'test-admin');
  assert.equal((await timeout.inject({ method: 'POST', url: '/v1/authorize', payload: { actorId: 'agent-1', toolId: 'tool-1' } })).statusCode, 504);
  await timeout.close();
});

test('JIT credentials require an active agent, scope, and bounded TTL', async () => {
  const agents = new MemoryAgentRepository();
  await agents.create({ id: 'agent-cred', name: 'Credential Agent', ownerId: 'owner-1', purpose: 'credential test', riskTier: 'low' });
  const audit = new MemoryAuditRepository();
  const credentials = new MemoryCredentialRepository(agents);
  const app = buildApp(agents, undefined, credentials, audit, undefined, 'test-admin');
  const issued = await app.inject({ method: 'POST', url: '/v1/agents/agent-cred/credentials', headers: adminHeaders, payload: { scope: ['tools:read'], ttlSeconds: 60 } });
  assert.equal(issued.statusCode, 201);
  const body = issued.json();
  assert.match(body.secret, /^[A-Za-z0-9_-]+$/);
  assert.equal(body.scope[0], 'tools:read');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents/missing/credentials', headers: adminHeaders, payload: { scope: ['tools:read'] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents/agent-cred/credentials', headers: adminHeaders, payload: { scope: [], ttlSeconds: 60 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/agents/agent-cred/credentials', headers: adminHeaders, payload: { scope: ['tools:read'], ttlSeconds: 3601 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/credentials/${body.id}/revoke`, headers: adminHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/credentials/${body.id}/revoke`, headers: adminHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/credentials/missing/revoke', headers: adminHeaders })).statusCode, 404);
  const events = await audit.list();
  assert.equal(events.filter((event) => event.eventType === 'credential_issued').length, 1);
  assert.equal(events.filter((event) => event.eventType === 'credential_revoked').length, 2);
  await app.close();
});

test('protected MCP invocation validates credential scope and records correlation', async () => {
  const agents = new MemoryAgentRepository();
  await agents.create({ id: 'agent-mcp', name: 'MCP Agent', ownerId: 'owner-1', purpose: 'invoke test', riskTier: 'low' });
  const credentials = new MemoryCredentialRepository(agents);
  const issued = await credentials.issue({ agentId: 'agent-mcp', scope: ['tool:weather'], ttlSeconds: 60 });
  const audit = new MemoryAuditRepository();
  const app = buildApp(agents, async () => ({ allowed: true, reason: 'allowed' }), credentials, audit, undefined, 'test-admin');
  const response = await app.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: `Bearer ${issued.secret}`, 'x-correlation-id': 'corr-1' },
    payload: { agentId: 'agent-mcp', toolId: 'weather', credentialId: issued.id },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().correlationId, 'corr-1');
  assert.equal(response.json().result.output.accepted, true);
  assert.equal(JSON.stringify(await audit.list()).includes(issued.secret), false);
  const denied = await app.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: `Bearer ${issued.secret}`, 'x-correlation-id': 'corr-2' },
    payload: { agentId: 'agent-mcp', toolId: 'email', credentialId: issued.id },
  });
  assert.equal(denied.statusCode, 401);
  const wrongAgent = await app.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: `Bearer ${issued.secret}` },
    payload: { agentId: 'other-agent', toolId: 'weather', credentialId: issued.id },
  });
  assert.equal(wrongAgent.statusCode, 401);
  const malformedBearer = await app.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: 'Basic not-a-bearer' },
    payload: { agentId: 'agent-mcp', toolId: 'weather', credentialId: issued.id },
  });
  assert.equal(malformedBearer.statusCode, 400);
  await credentials.revoke(issued.id);
  const revoked = await app.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: `Bearer ${issued.secret}` },
    payload: { agentId: 'agent-mcp', toolId: 'weather', credentialId: issued.id },
  });
  assert.equal(revoked.statusCode, 401);
  assert.equal((await audit.list()).filter((event) => event.correlationId === 'corr-1').length, 2);
  await app.close();
});

test('MCP invocation records policy denial and rejects expired credentials', async () => {
  const agents = new MemoryAgentRepository();
  await agents.create({ id: 'agent-deny', name: 'Denied Agent', ownerId: 'owner-1', purpose: 'deny test', riskTier: 'low' });
  const credentials = new MemoryCredentialRepository(agents);
  const audit = new MemoryAuditRepository();
  const deniedApp = buildApp(agents, async () => ({ allowed: false, reason: 'policy denied' }), credentials, audit, undefined, 'test-admin');
  const deniedCredential = await credentials.issue({ agentId: 'agent-deny', scope: ['tool:blocked'], ttlSeconds: 60 });
  const denied = await deniedApp.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: `Bearer ${deniedCredential.secret}`, 'x-correlation-id': 'deny-1' },
    payload: { agentId: 'agent-deny', toolId: 'blocked', credentialId: deniedCredential.id },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal((await audit.list()).filter((event) => event.correlationId === 'deny-1' && event.allowed === false).length, 2);
  await deniedApp.close();

  const expired = await credentials.issue({ agentId: 'agent-deny', scope: ['tool:expired'], ttlSeconds: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const expiredApp = buildApp(agents, async () => ({ allowed: true, reason: 'should not run' }), credentials, audit, undefined, 'test-admin');
  const expiredResponse = await expiredApp.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: `Bearer ${expired.secret}` },
    payload: { agentId: 'agent-deny', toolId: 'expired', credentialId: expired.id },
  });
  assert.equal(expiredResponse.statusCode, 401);
  await expiredApp.close();
});

test('MCP invocation audits tool adapter failures and does not hide the error', async () => {
  const agents = new MemoryAgentRepository();
  await agents.create({ id: 'agent-tool-error', name: 'Tool Error Agent', ownerId: 'owner-1', purpose: 'adapter test', riskTier: 'low' });
  const credentials = new MemoryCredentialRepository(agents);
  const issued = await credentials.issue({ agentId: 'agent-tool-error', scope: ['tool:broken'], ttlSeconds: 60 });
  const audit = new MemoryAuditRepository();
  const app = buildApp(
    agents,
    async () => ({ allowed: true, reason: 'allowed', policyId: 'allow-tool' }),
    credentials,
    audit,
    async () => { throw new Error('downstream tool unavailable'); },
  );
  const response = await app.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: 'Bearer ' + issued.secret, 'x-correlation-id': 'tool-error-1' },
    payload: { agentId: 'agent-tool-error', toolId: 'broken', credentialId: issued.id },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().reason, 'downstream tool unavailable');
  assert.equal((await audit.list()).some((event) => event.correlationId === 'tool-error-1' && event.allowed === false && event.rationale === 'downstream tool unavailable'), true);
  await app.close();
});
