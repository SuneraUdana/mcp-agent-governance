import type { AuthorizationDecision, AuthorizationDecisionWire, Policy } from './types.js';

export type AuthorizationRequest = {
  actorId: string;
  toolId: string;
  action?: string;
  context?: Record<string, unknown>;
};

export type PolicyAuthorizer = (request: AuthorizationRequest) => Promise<AuthorizationDecision>;
export type PolicyGateway = {
  listPolicies(): Promise<Policy[]>;
  health(): Promise<{ status: 'ok' | 'unavailable'; detail?: string }>;
};

export class PolicyServiceUnavailableError extends Error {}
export class PolicyServiceTimeoutError extends Error {}

export function createPolicyAuthorizer(
  baseUrl = process.env.POLICY_SERVICE_URL ?? 'http://localhost:8000',
  timeoutMs = Number(process.env.POLICY_SERVICE_TIMEOUT_MS ?? 2000),
  serviceToken = process.env.POLICY_SERVICE_TOKEN,
): PolicyAuthorizer {
  return async (request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/authorize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(serviceToken ? { authorization: `Bearer ${serviceToken}` } : {}),
        },
        body: JSON.stringify({
          actor_id: request.actorId,
          tool_id: request.toolId,
          action: request.action ?? 'invoke',
          context: request.context ?? {},
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new PolicyServiceUnavailableError(`policy service returned HTTP ${response.status}`);
      const decision = await response.json() as Partial<AuthorizationDecisionWire>;
      if (typeof decision.allowed !== 'boolean' || typeof decision.reason !== 'string' ||
        (typeof decision.policy_id !== 'string' && decision.policy_id !== null)) {
        throw new PolicyServiceUnavailableError('policy service returned an invalid decision');
      }
      return { allowed: decision.allowed, reason: decision.reason, ...(decision.policy_id === null ? {} : { policyId: decision.policy_id }) };
    } catch (error) {
      if (error instanceof PolicyServiceUnavailableError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new PolicyServiceTimeoutError(`policy service did not respond within ${timeoutMs}ms`);
      throw new PolicyServiceUnavailableError('policy service is unavailable');
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createPolicyGateway(
  baseUrl = process.env.POLICY_SERVICE_URL ?? 'http://localhost:8000',
  timeoutMs = Number(process.env.POLICY_SERVICE_TIMEOUT_MS ?? 2000),
  adminToken = process.env.POLICY_ADMIN_TOKEN,
): PolicyGateway {
  return {
    async listPolicies() {
      const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/v1/policies`, {
        headers: { ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) },
      }, timeoutMs);
      if (!response.ok) throw new PolicyServiceUnavailableError(`policy service returned HTTP ${response.status}`);
      const values = await response.json() as Array<Record<string, unknown>>;
      return values.map((value) => ({
        policyId: String(value.policy_id),
        effect: value.effect as 'allow' | 'deny',
        toolId: String(value.tool_id),
        actorId: value.actor_id == null ? null : String(value.actor_id),
        action: String(value.action),
        reason: String(value.reason),
        version: Number(value.version),
        status: value.status as 'active' | 'disabled' | undefined,
        createdAt: value.created_at as string | undefined,
        updatedAt: value.updated_at as string | undefined,
      }));
    },
    async health() {
      try {
        const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, '')}/health`, {}, timeoutMs);
        return response.ok ? { status: 'ok' } : { status: 'unavailable', detail: `HTTP ${response.status}` };
      } catch {
        return { status: 'unavailable', detail: 'policy service is unavailable' };
      }
    },
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new PolicyServiceTimeoutError(`policy service did not respond within ${timeoutMs}ms`);
    throw new PolicyServiceUnavailableError('policy service is unavailable');
  } finally {
    clearTimeout(timeout);
  }
}
