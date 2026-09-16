import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { AgentRepository } from './registry.js';
import type { CredentialIssuance, CredentialRecord } from './types.js';

export const DEFAULT_CREDENTIAL_TTL_SECONDS = 900;
export const MAX_CREDENTIAL_TTL_SECONDS = 3600;

export class CredentialValidationError extends Error {}
export class CredentialNotFoundError extends Error {}

export type CredentialRequest = { agentId: string; scope: string[]; ttlSeconds?: number };

export interface CredentialRepository {
  issue(request: CredentialRequest): Promise<CredentialIssuance>;
  revoke(id: string): Promise<CredentialRecord | undefined>;
  verify(id: string, secret: string, agentId: string, requiredScope: string): Promise<CredentialRecord>;
}

type StoredCredential = CredentialRecord & { secretHash: string };

export function hashesMatch(providedHash: string, storedHash: string): boolean {
  const provided = Buffer.from(providedHash, 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}

export function validateCredentialRequest(request: CredentialRequest): void {
  if (!request.agentId?.trim()) throw new CredentialValidationError('agentId is required');
  if (!Array.isArray(request.scope) || request.scope.length === 0 || request.scope.length > 20) {
    throw new CredentialValidationError('scope must contain between 1 and 20 permissions');
  }
  if (request.scope.some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9:_-]{0,99}$/i.test(item))) {
    throw new CredentialValidationError('scope entries must be short permission names');
  }
  const ttl = request.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_CREDENTIAL_TTL_SECONDS) {
    throw new CredentialValidationError(`ttlSeconds must be an integer between 1 and ${MAX_CREDENTIAL_TTL_SECONDS}`);
  }
}

export class MemoryCredentialRepository implements CredentialRepository {
  private readonly credentials = new Map<string, StoredCredential>();
  constructor(private readonly agents: AgentRepository) {}

  async issue(request: CredentialRequest): Promise<CredentialIssuance> {
    validateCredentialRequest(request);
    const agent = await this.agents.get(request.agentId);
    if (!agent || agent.status !== 'active') throw new CredentialValidationError('agent must exist and be active');
    const secret = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (request.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000).toISOString();
    const record: StoredCredential = {
      id: `cred_${randomBytes(12).toString('hex')}`, agentId: request.agentId,
      scope: [...new Set(request.scope)], expiresAt, createdAt: now.toISOString(),
      secretHash: createHash('sha256').update(secret).digest('hex'),
    };
    this.credentials.set(record.id, record);
    const { secretHash: _, ...publicRecord } = record;
    return { ...publicRecord, secret };
  }

  async revoke(id: string): Promise<CredentialRecord | undefined> {
    const record = this.credentials.get(id);
    if (!record) return undefined;
    if (!record.revokedAt) record.revokedAt = new Date().toISOString();
    const { secretHash: _, ...publicRecord } = record;
    return publicRecord;
  }

  async verify(id: string, secret: string, agentId: string, requiredScope: string): Promise<CredentialRecord> {
    const record = this.credentials.get(id);
    if (!record || record.agentId !== agentId) throw new CredentialValidationError('credential is invalid');
    if (record.revokedAt || Date.parse(record.expiresAt) <= Date.now()) throw new CredentialValidationError('credential is expired or revoked');
    const hash = createHash('sha256').update(secret).digest('hex');
    if (!hashesMatch(hash, record.secretHash)) throw new CredentialValidationError('credential is invalid');
    if (!record.scope.includes(requiredScope) && !record.scope.includes('tools:invoke')) {
      throw new CredentialValidationError('credential scope does not permit this tool');
    }
    const { secretHash: _, ...publicRecord } = record;
    return publicRecord;
  }
}
