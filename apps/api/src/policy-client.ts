import type { AuthorizationDecision } from './types.js';

export type AuthorizationRequest = {
  actorId: string;
  toolId: string;
  action?: string;
  context?: Record<string, unknown>;
};

export type PolicyAuthorizer = (request: AuthorizationRequest) => Promise<AuthorizationDecision>;

export class PolicyServiceUnavailableError extends Error {}
export class PolicyServiceTimeoutError extends Error {}

export function createPolicyAuthorizer(
  baseUrl = process.env.POLICY_SERVICE_URL ?? 'http://localhost:8000',
  timeoutMs = Number(process.env.POLICY_SERVICE_TIMEOUT_MS ?? 2000),
): PolicyAuthorizer {
  return async (request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor_id: request.actorId,
          tool_id: request.toolId,
          action: request.action ?? 'invoke',
          context: request.context ?? {},
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new PolicyServiceUnavailableError(`policy service returned HTTP ${response.status}`);
      const decision = await response.json() as Partial<AuthorizationDecision> & { policy_id?: string };
      if (typeof decision.allowed !== 'boolean' || typeof decision.reason !== 'string') {
        throw new PolicyServiceUnavailableError('policy service returned an invalid decision');
      }
      return { allowed: decision.allowed, reason: decision.reason, policyId: decision.policyId ?? decision.policy_id };
    } catch (error) {
      if (error instanceof PolicyServiceUnavailableError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PolicyServiceTimeoutError(`policy service did not respond within ${timeoutMs}ms`);
      }
      throw new PolicyServiceUnavailableError('policy service is unavailable');
    } finally {
      clearTimeout(timeout);
    }
  };
}
