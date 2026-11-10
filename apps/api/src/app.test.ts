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

test('dashboard overview and audit endpoints are authenticated and read-only', async () => {
  const agents = new MemoryAgentRepository();
  const audit = new MemoryAuditRepository();
  await agents.create({ id: 'dashboard-agent', name: 'Dashboard Agent', ownerId: 'owner-1', purpose: 'overview test', riskTier: 'high' });
  await audit.record({
    correlationId: 'dashboard-1',
    eventType: 'authorization',
    agentId: 'dashboard-agent',
    allowed: false,
    rationale: 'policy denied',
    metadata: { policyId: 'policy-1', token: 'must-not-leak' },
  });

  test('operator read models expose identity, correlated audit filters, policies, simulation, and health', async () => {
    const agents = new MemoryAgentRepository();
    const audit = new MemoryAuditRepository();
    await agents.create({ id: 'operator-agent', name: 'Operator Agent', ownerId: 'owner-1', purpose: 'operator test', riskTier: 'medium', identityMetadata: { provider: 'demo', subject: 'sub-1' } });
    await audit.record({ correlationId: 'corr-match', eventType: 'authorization', agentId: 'operator-agent', toolId: 'weather', allowed: true, rationale: 'matched policy', metadata: {} });
    await audit.record({ correlationId: 'corr-other', eventType: 'tool_invocation', agentId: 'other-agent', toolId: 'email', allowed: false, rationale: 'denied', metadata: {} });
    const app = buildApp(
      agents,
      async () => ({ allowed: true, reason: 'matched policy', policyId: 'policy-weather' }),
      undefined,
      audit,
      undefined,
      'test-admin',
      { listPolicies: async () => [{ policyId: 'policy-weather', effect: 'allow', toolId: 'weather', actorId: 'operator-agent', action: 'invoke', reason: 'approved', version: 3 }], health: async () => ({ status: 'ok' }) },
    );
    const detail = await app.inject({ method: 'GET', url: '/v1/dashboard/agents/operator-agent', headers: adminHeaders });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().agent.identityMetadata, { provider: 'demo', subject: 'sub-1' });
    assert.equal(detail.json().auditTimeline[0].correlationId, 'corr-match');
    assert.equal(detail.json().policies[0].version, 3);
    const filtered = await app.inject({ method: 'GET', url: '/v1/audit?agentId=operator-agent&toolId=weather&decision=allowed&correlationId=corr-match', headers: adminHeaders });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().total, 1);
    const simulation = await app.inject({ method: 'POST', url: '/v1/policies/simulate', headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: { actorId: 'operator-agent', toolId: 'weather' } });
    assert.equal(simulation.statusCode, 200);
    assert.match(simulation.json().explanation, /Allowed/);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/dashboard/health', headers: adminHeaders })).json().policy, { status: 'ok' });
    await app.close();
  });
  await audit.record({
    correlationId: 'dashboard-2',
    eventType: 'tool_invocation',
    agentId: 'dashboard-agent',
    allowed: true,
    rationale: 'allowed',
    metadata: { credentialSecret: 'must-not-leak' },
  });
  const app = buildApp(agents, undefined, undefined, audit, undefined, 'test-admin');
  assert.equal((await app.inject('/v1/dashboard/summary')).statusCode, 401);
  const summary = await app.inject({ method: 'GET', url: '/v1/dashboard/summary', headers: adminHeaders });
  assert.equal(summary.statusCode, 200);
  assert.deepEqual(summary.json().agents, {
    total: 1,
    active: 1,
    disabled: 0,
    byRiskTier: { low: 0, medium: 0, high: 1 },
  });
  assert.equal(summary.json().audit.total, 2);
  assert.equal(summary.json().audit.allowed, 1);
  assert.equal(summary.json().audit.denied, 1);
  assert.equal(summary.json().recentEvents.some((event: { metadata: Record<string, unknown> }) => event.metadata.credentialSecret === '[REDACTED]'), true);
  const filtered = await app.inject({ method: 'GET', url: '/v1/audit?eventType=authorization&limit=1', headers: adminHeaders });
  assert.equal(filtered.statusCode, 200);
  assert.equal(filtered.json().events.length, 1);
  assert.equal(filtered.json().total, 1);
  assert.equal(filtered.json().events[0].metadata.token, '[REDACTED]');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/audit?limit=0', headers: adminHeaders })).statusCode, 400);
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

test('public API routes reject malformed JSON body types before handlers run', async () => {
  const agents = new MemoryAgentRepository();
  const credentials = new MemoryCredentialRepository(agents);
  const app = buildApp(agents, undefined, credentials, new MemoryAuditRepository(), undefined, 'test-admin');
  const cases = [
    { method: 'POST' as const, url: '/v1/agents', payload: 'null' },
    { method: 'PUT' as const, url: '/v1/agents/a1', payload: JSON.stringify({ name: ['not-a-string'] }) },
    { method: 'POST' as const, url: '/v1/agents/a1/credentials', payload: JSON.stringify({ scope: 'not-an-array' }) },
    { method: 'POST' as const, url: '/v1/mcp/invoke', payload: JSON.stringify({ agentId: {}, toolId: 'demo-tool', credentialId: 'credential' }) },
    { method: 'POST' as const, url: '/v1/authorize', payload: JSON.stringify({ actorId: 'agent', toolId: 42 }) },
  ];
  for (const request of cases) {
    const headers = request.url.startsWith('/v1/authorize') ? { 'content-type': 'application/json' } : { ...adminHeaders, 'content-type': 'application/json' };
    assert.equal((await app.inject({ ...request, headers })).statusCode, 400, request.url);
  }
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

test('empty or overlong correlation IDs are replaced', async () => {
  const agents = new MemoryAgentRepository();
  await agents.create({ id: 'agent-correlation', name: 'Correlation Agent', ownerId: 'owner-1', purpose: 'correlation test', riskTier: 'low' });
  const credentials = new MemoryCredentialRepository(agents);
  const issued = await credentials.issue({ agentId: 'agent-correlation', scope: ['tool:weather'], ttlSeconds: 60 });
  const app = buildApp(agents, async () => ({ allowed: true, reason: 'allowed' }), credentials, new MemoryAuditRepository(), undefined, 'test-admin');
  for (const value of ['   ', 'x'.repeat(129)]) {
    const response = await app.inject({
      method: 'POST', url: '/v1/mcp/invoke',
      headers: { authorization: `Bearer ${issued.secret}`, 'x-correlation-id': value },
      payload: { agentId: 'agent-correlation', toolId: 'weather', credentialId: issued.id },
    });
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.json().correlationId, value);
    assert.ok(response.json().correlationId.trim().length > 0);
    assert.ok(response.json().correlationId.length <= 128);
  }
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

test('tool execution is reported when its success audit write fails', async () => {
  const agents = new MemoryAgentRepository();
  await agents.create({ id: 'agent-audit-error', name: 'Audit Error Agent', ownerId: 'owner-1', purpose: 'audit test', riskTier: 'low' });
  const credentials = new MemoryCredentialRepository(agents);
  const issued = await credentials.issue({ agentId: 'agent-audit-error', scope: ['tool:weather'], ttlSeconds: 60 });
  let toolCalls = 0;
  const audit = {
    async record(event: Parameters<MemoryAuditRepository['record']>[0]) {
      if (event.eventType === 'tool_invocation' && event.allowed === true) throw new Error('audit store unavailable');
      return new MemoryAuditRepository().record(event);
    },
    async list() { return []; },
  };
  const app = buildApp(
    agents,
    async () => ({ allowed: true, reason: 'allowed', policyId: 'allow-tool' }),
    credentials,
    audit,
    async () => {
      toolCalls += 1;
      return { toolId: 'weather', output: { accepted: true } };
    },
  );
  const response = await app.inject({
    method: 'POST', url: '/v1/mcp/invoke',
    headers: { authorization: `Bearer ${issued.secret}`, 'x-correlation-id': 'audit-error-1' },
    payload: { agentId: 'agent-audit-error', toolId: 'weather', credentialId: issued.id },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error, 'tool executed but audit recording failed');
  assert.equal(response.json().toolExecuted, true);
  assert.equal(toolCalls, 1);
  await app.close();
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
