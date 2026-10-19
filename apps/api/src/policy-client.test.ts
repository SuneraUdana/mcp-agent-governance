import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyAuthorizer } from './policy-client.js';

test('policy client sends the service bearer token', async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ allowed: true, reason: 'allowed', policy_id: 'policy-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const decision = await createPolicyAuthorizer('http://policy.test', 1000, 'service-secret')({
      actorId: 'agent-1',
      toolId: 'tool-1',
    });
    assert.deepEqual(decision, { allowed: true, reason: 'allowed', policyId: 'policy-1' });
    assert.deepEqual(await request?.json(), {
      actor_id: 'agent-1',
      tool_id: 'tool-1',
      action: 'invoke',
      context: {},
    });
    assert.equal(request?.headers.get('authorization'), 'Bearer service-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('policy client maps a default-deny wire decision without accepting camelCase output', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    allowed: false,
    reason: 'No matching policy',
    policy_id: null,
  }), { status: 200 });

  try {
    const decision = await createPolicyAuthorizer('http://policy.test')({
      actorId: 'agent-1',
      toolId: 'tool-1',
    });
    assert.deepEqual(decision, { allowed: false, reason: 'No matching policy' });

    globalThis.fetch = async () => new Response(JSON.stringify({
      allowed: true,
      reason: 'allowed',
      policyId: 'camel-case-is-not-wire-contract',
    }), { status: 200 });
    await assert.rejects(
      createPolicyAuthorizer('http://policy.test')({ actorId: 'agent-1', toolId: 'tool-1' }),
      /invalid decision/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
