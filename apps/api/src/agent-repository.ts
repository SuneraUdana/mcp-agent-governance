import type { AgentRepository } from './registry.js';
import { MemoryAgentRepository } from './registry.js';
import { PostgresAgentRepository } from './postgres-repository.js';
import { MemoryCredentialRepository } from './credentials.js';
import { PostgresCredentialRepository } from './postgres-credentials.js';
import type { CredentialRepository } from './credentials.js';
import { MemoryAuditRepository } from './audit.js';
import { PostgresAuditRepository } from './postgres-audit.js';
import type { AuditRepository } from './audit.js';

export type RepositorySelection = { repository: AgentRepository; credentials: CredentialRepository; audit: AuditRepository; close?: () => Promise<void> };

export function createAgentRepository(env = process.env): RepositorySelection {
  if (env.AGENT_REPOSITORY === 'postgres') {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required when AGENT_REPOSITORY=postgres');
    const repository = new PostgresAgentRepository(env.DATABASE_URL);
    const credentials = new PostgresCredentialRepository(env.DATABASE_URL, repository);
    const audit = new PostgresAuditRepository(env.DATABASE_URL);
    return { repository, credentials, audit, close: async () => { await audit.close(); await credentials.close(); await repository.close(); } };
  }
  const repository = new MemoryAgentRepository();
  return { repository, credentials: new MemoryCredentialRepository(repository), audit: new MemoryAuditRepository() };
}
