import type { Agent, AgentInput, AgentStatus } from './types.js';

export interface AgentRepository {
  create(input: AgentInput): Promise<Agent>;
  get(id: string): Promise<Agent | undefined>;
  list(): Promise<Agent[]>;
  update(id: string, input: Omit<AgentInput, 'id'>): Promise<Agent | undefined>;
  deactivate(id: string): Promise<Agent | undefined>;
}

export class AgentValidationError extends Error {}
export class AgentConflictError extends Error {}

export function validateAgentInput(input: AgentInput | Omit<AgentInput, 'id'>): void {
  if ('id' in input && (!input.id || input.id.trim().length > 100)) throw new AgentValidationError('id is required and must be at most 100 characters');
  if (!input.name?.trim() || input.name.trim().length > 200) throw new AgentValidationError('name is required and must be at most 200 characters');
  if (!input.ownerId?.trim() || input.ownerId.trim().length > 100) throw new AgentValidationError('ownerId is required and must be at most 100 characters');
  if (!input.purpose?.trim() || input.purpose.trim().length > 1000) throw new AgentValidationError('purpose is required and must be at most 1000 characters');
  if (!['low', 'medium', 'high'].includes(input.riskTier)) throw new AgentValidationError('riskTier must be low, medium, or high');
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw new AgentValidationError('expiresAt must be a valid ISO-8601 timestamp');
}

function statusForExpiry(expiresAt?: string): AgentStatus {
  return expiresAt && Date.parse(expiresAt) <= Date.now() ? 'disabled' : 'active';
}

export class MemoryAgentRepository implements AgentRepository {
  private readonly agents = new Map<string, Agent>();

  async create(input: AgentInput): Promise<Agent> {
    validateAgentInput(input);
    if (this.agents.has(input.id)) throw new AgentConflictError('agent already exists');
    const now = new Date().toISOString();
    const agent: Agent = { ...input, status: statusForExpiry(input.expiresAt), createdAt: now, updatedAt: now };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async get(id: string): Promise<Agent | undefined> {
    const agent = this.agents.get(id);
    if (agent?.status === 'active' && agent.expiresAt && Date.parse(agent.expiresAt) <= Date.now()) {
      return this.deactivate(id);
    }
    return agent;
  }

  async list(): Promise<Agent[]> {
    await Promise.all([...this.agents.keys()].map((id) => this.get(id)));
    return [...this.agents.values()];
  }

  async update(id: string, input: Omit<AgentInput, 'id'>): Promise<Agent | undefined> {
    validateAgentInput({ id, ...input });
    const existing = await this.get(id);
    if (!existing || existing.status === 'disabled') return undefined;
    const updated: Agent = { ...existing, ...input, status: statusForExpiry(input.expiresAt), updatedAt: new Date().toISOString() };
    this.agents.set(id, updated);
    return updated;
  }

  async deactivate(id: string): Promise<Agent | undefined> {
    const existing = this.agents.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, status: 'disabled' as const, updatedAt: new Date().toISOString() };
    this.agents.set(id, updated);
    return updated;
  }
}
