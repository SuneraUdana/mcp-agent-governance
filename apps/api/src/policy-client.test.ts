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
    assert.equal(request?.headers.get('authorization'), 'Bearer service-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
