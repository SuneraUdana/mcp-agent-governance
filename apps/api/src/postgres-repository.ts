import pg from 'pg';
import type { Agent, AgentInput } from './types.js';
import { AgentConflictError, type AgentRepository, validateAgentInput } from './registry.js';

const { Pool } = pg;

export class PostgresAgentRepository implements AgentRepository {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl }); }
  async close(): Promise<void> { await this.pool.end(); }

  async create(input: AgentInput): Promise<Agent> {
    validateAgentInput(input);
    const result = await this.pool.query<Agent>(
      `INSERT INTO agents (id, name, owner_id, purpose, risk_tier, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::timestamptz IS NOT NULL AND $6::timestamptz <= NOW() THEN 'disabled' ELSE 'active' END, $6)
       RETURNING id, name, owner_id AS "ownerId", purpose, risk_tier AS "riskTier",
                 status, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [input.id, input.name.trim(), input.ownerId.trim(), input.purpose.trim(), input.riskTier, input.expiresAt ?? null],
    ).catch((error: { code?: string }) => {
      if (error.code === '23505') throw new AgentConflictError('agent already exists');
      throw error;
    });
    return result.rows[0];
  }
  async get(id: string): Promise<Agent | undefined> {
    const result = await this.pool.query<Agent>(
      `UPDATE agents SET status = 'disabled', updated_at = NOW()
       WHERE id = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
       RETURNING id, name, owner_id AS "ownerId", purpose, risk_tier AS "riskTier",
                 status, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id],
    );
    if (result.rows[0]) return result.rows[0];
    const found = await this.pool.query<Agent>(agentSelect('WHERE id = $1'), [id]);
    return found.rows[0];
  }
  async list(): Promise<Agent[]> {
    await this.pool.query(`UPDATE agents SET status = 'disabled', updated_at = NOW() WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`);
    return (await this.pool.query<Agent>(agentSelect('ORDER BY created_at ASC'))).rows;
  }
  async update(id: string, input: Omit<AgentInput, 'id'>): Promise<Agent | undefined> {
    validateAgentInput({ id, ...input });
    const result = await this.pool.query<Agent>(
      `UPDATE agents SET name = $2, owner_id = $3, purpose = $4, risk_tier = $5,
       status = CASE WHEN $6::timestamptz IS NOT NULL AND $6::timestamptz <= NOW() THEN 'disabled' ELSE 'active' END,
       expires_at = $6, updated_at = NOW()
       WHERE id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING id, name, owner_id AS "ownerId", purpose, risk_tier AS "riskTier",
                 status, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id, input.name.trim(), input.ownerId.trim(), input.purpose.trim(), input.riskTier, input.expiresAt ?? null],
    );
    return result.rows[0] ?? undefined;
  }
  async deactivate(id: string): Promise<Agent | undefined> {
    const result = await this.pool.query<Agent>(
      `UPDATE agents SET status = 'disabled', updated_at = NOW() WHERE id = $1
       RETURNING id, name, owner_id AS "ownerId", purpose, risk_tier AS "riskTier",
                 status, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [id],
    );
    return result.rows[0];
  }
}

function agentSelect(suffix: string): string {
  return `SELECT id, name, owner_id AS "ownerId", purpose, risk_tier AS "riskTier",
                 status, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"
          FROM agents ${suffix}`;
}
