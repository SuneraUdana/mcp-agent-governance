const apiUrl = process.env.DEMO_API_URL ?? 'http://localhost:3000';
const policyUrl = process.env.DEMO_POLICY_URL ?? 'http://localhost:8000';
const apiAdminToken = process.env.ADMIN_API_TOKEN;
const policyAdminToken = process.env.POLICY_ADMIN_TOKEN;
if (!apiAdminToken || !policyAdminToken) throw new Error('ADMIN_API_TOKEN and POLICY_ADMIN_TOKEN are required for demo seeding');

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(`${response.status} ${body.error ?? body.detail ?? 'request failed'}`);
  return body;
}

const agent = await request<{ id: string }>(`${apiUrl}/v1/agents`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiAdminToken}` },
  body: JSON.stringify({
    id: 'demo-agent',
    name: 'Governance Demo Agent',
    ownerId: 'demo-owner',
    purpose: 'Show the governed external tool flow',
    riskTier: 'low',
  }),
}).catch(async (error) => {
  if (String(error).includes('409')) return { id: 'demo-agent' };
  throw error;
});

await request(`${policyUrl}/v1/policies`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${policyAdminToken}` },
  body: JSON.stringify({
    policy_id: 'demo-tool-allow',
    effect: 'allow',
    actor_id: agent.id,
    tool_id: 'demo-tool',
    action: 'invoke',
    reason: 'Demo agent is allowed to invoke the demo tool',
  }),
}).catch((error) => {
  if (!String(error).includes('409')) throw error;
});

const credential = await request<{ id: string; secret: string; expiresAt: string }>(
  `${apiUrl}/v1/agents/${agent.id}/credentials`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiAdminToken}` },
    body: JSON.stringify({ scope: ['tool:demo-tool'], ttlSeconds: 900 }),
  },
);

console.log(JSON.stringify({
  apiUrl,
  policyUrl,
  agentId: agent.id,
  toolId: 'demo-tool',
  credentialId: credential.id,
  secret: credential.secret,
  expiresAt: credential.expiresAt,
  invokeCommand: `curl -X POST ${apiUrl}/v1/mcp/invoke -H "authorization: Bearer ${credential.secret}" -H "content-type: application/json" -d '{"agentId":"${agent.id}","toolId":"demo-tool","credentialId":"${credential.id}","payload":{"message":"hello"}}'`,
}, null, 2));
