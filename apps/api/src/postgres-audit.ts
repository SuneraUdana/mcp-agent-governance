import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { AuditEvent } from './types.js';
import type { AuditRepository } from './audit.js';

export class PostgresAuditRepository implements AuditRepository {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) { this.pool = new pg.Pool({ connectionString: databaseUrl }); }
  async close(): Promise<void> { await this.pool.end(); }
  async record(event: Omit<AuditEvent, 'id' | 'occurredAt'>): Promise<AuditEvent> {
    const saved = { ...event, id: randomUUID(), occurredAt: new Date().toISOString() };
    await this.pool.query(
      `INSERT INTO audit_events
       (id, correlation_id, event_type, occurred_at, actor_id, agent_id, tool_id,
        credential_id, allowed, rationale, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [saved.id, saved.correlationId, saved.eventType, saved.occurredAt, saved.actorId ?? null,
        saved.agentId ?? null, saved.toolId ?? null, saved.credentialId ?? null,
        saved.allowed ?? null, saved.rationale, JSON.stringify(saved.metadata)],
    );
    return saved;
  }
  async list(): Promise<AuditEvent[]> {
    const result = await this.pool.query<AuditEvent>(
      `SELECT id, correlation_id AS "correlationId", event_type AS "eventType",
              occurred_at AS "occurredAt", actor_id AS "actorId", agent_id AS "agentId",
              tool_id AS "toolId", credential_id AS "credentialId", allowed, rationale, metadata
       FROM audit_events ORDER BY occurred_at ASC`);
    return result.rows;
  }
}
