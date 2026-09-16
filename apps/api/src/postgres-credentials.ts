import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentRepository } from './registry.js';
import type { CredentialIssuance, CredentialRecord } from './types.js';
import { CredentialValidationError, hashesMatch, validateCredentialRequest, type CredentialRepository, type CredentialRequest, DEFAULT_CREDENTIAL_TTL_SECONDS } from './credentials.js';

export class PostgresCredentialRepository implements CredentialRepository {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string, private readonly agents: AgentRepository) { this.pool = new pg.Pool({ connectionString: databaseUrl }); }
  async close(): Promise<void> { await this.pool.end(); }

  async issue(request: CredentialRequest): Promise<CredentialIssuance> {
    validateCredentialRequest(request);
    const agent = await this.agents.get(request.agentId);
    if (!agent || agent.status !== 'active') throw new CredentialValidationError('agent must exist and be active');
    const ttl = request.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS;
    const secret = randomBytes(32).toString('base64url');
    const result = await this.pool.query<CredentialRecord>(
      `INSERT INTO credentials (agent_id, scope, secret_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'))
       RETURNING id, agent_id AS "agentId", scope, expires_at AS "expiresAt", created_at AS "createdAt"`,
      [request.agentId, [...new Set(request.scope)], createHash('sha256').update(secret).digest('hex'), ttl],
    );
    return { ...result.rows[0], secret };
  }

  async revoke(id: string): Promise<CredentialRecord | undefined> {
    const result = await this.pool.query<CredentialRecord>(
      `UPDATE credentials SET revoked_at = COALESCE(revoked_at, NOW())
       WHERE id = $1
       RETURNING id, agent_id AS "agentId", scope, expires_at AS "expiresAt",
                 revoked_at AS "revokedAt", created_at AS "createdAt"`, [id],
    );
    return result.rows[0];
  }

  async verify(id: string, secret: string, agentId: string, requiredScope: string): Promise<CredentialRecord> {
    const result = await this.pool.query<CredentialRecord & { secretHash: string }>(
      `SELECT id, agent_id AS "agentId", scope, expires_at AS "expiresAt",
              revoked_at AS "revokedAt", created_at AS "createdAt",
              secret_hash AS "secretHash"
       FROM credentials WHERE id = $1 AND agent_id = $2`, [id, agentId],
    );
    const record = result.rows[0];
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= Date.now() ||
      !hashesMatch(createHash('sha256').update(secret).digest('hex'), record.secretHash)) {
      throw new CredentialValidationError('credential is invalid, expired, or revoked');
    }
    if (!record.scope.includes(requiredScope) && !record.scope.includes('tools:invoke')) {
      throw new CredentialValidationError('credential scope does not permit this tool');
    }
    const { secretHash: _, ...publicRecord } = record;
    return publicRecord;
  }
}
