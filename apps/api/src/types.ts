export type RiskTier = 'low' | 'medium' | 'high';
export type AgentStatus = 'active' | 'disabled';
export type Agent = {
  id: string;
  name: string;
  ownerId: string;
  purpose: string;
  riskTier: RiskTier;
  identityMetadata?: Record<string, string>;
  status: AgentStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};
export type AgentInput = Pick<Agent, 'id' | 'name' | 'ownerId' | 'purpose' | 'riskTier'> & { expiresAt?: string; identityMetadata?: Record<string, string> };
export type Owner = { id: string; name: string; email?: string };
export type Credential = { id: string; ownerId: string; kind: string; secretRef?: string };
export type CredentialRecord = {
  id: string;
  agentId: string;
  scope: string[];
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
};
export type CredentialIssuance = CredentialRecord & { secret: string };
export type AuditEvent = {
  id: string;
  correlationId: string;
  eventType: 'authorization' | 'credential_issued' | 'credential_revoked' | 'tool_invocation';
  occurredAt: string;
  actorId?: string;
  agentId?: string;
  toolId?: string;
  credentialId?: string;
  allowed?: boolean;
  rationale: string;
  metadata: Record<string, unknown>;
};
export type AuditEventType = AuditEvent['eventType'];
export type AuditListResponse = {
  events: AuditEvent[];
  total: number;
};
export type DashboardSummary = {
  generatedAt: string;
  agents: {
    total: number;
    active: number;
    disabled: number;
    byRiskTier: Record<RiskTier, number>;
  };
  audit: {
    total: number;
    allowed: number;
    denied: number;
    byEventType: Record<AuditEventType, number>;
  };
  recentEvents: AuditEvent[];
};
/** Internal/public API shape; the policy-service adapter maps this to snake_case wire JSON. */
export type Policy = {
  policyId: string;
  effect: 'allow' | 'deny';
  toolId: string;
  actorId?: string | null;
  action: string;
  reason: string;
  version: number;
  status?: 'active' | 'disabled';
  createdAt?: string;
  updatedAt?: string;
};
export type PolicyWire = {
  policy_id: string;
  effect: 'allow' | 'deny';
  tool_id: string;
  actor_id?: string | null;
  action: string;
  reason: string;
  version: number;
  status?: 'active' | 'disabled';
  created_at?: string;
  updated_at?: string;
};
export type Tool = { id: string; name: string; mcpServer: string };
export type AuthorizationDecision = { allowed: boolean; reason: string; policyId?: string };
export type AuthorizationDecisionWire = {
  allowed: boolean;
  reason: string;
  policy_id: string | null;
};
