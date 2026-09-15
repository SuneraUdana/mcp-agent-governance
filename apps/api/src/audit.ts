import { randomUUID } from 'node:crypto';
import type { AuditEvent } from './types.js';

export interface AuditRepository {
  record(event: Omit<AuditEvent, 'id' | 'occurredAt'>): Promise<AuditEvent>;
  list(): Promise<AuditEvent[]>;
}

export class MemoryAuditRepository implements AuditRepository {
  private readonly events: AuditEvent[] = [];
  async record(event: Omit<AuditEvent, 'id' | 'occurredAt'>): Promise<AuditEvent> {
    const saved = { ...event, id: randomUUID(), occurredAt: new Date().toISOString() };
    this.events.push(saved);
    return saved;
  }
  async list(): Promise<AuditEvent[]> { return [...this.events]; }
}
