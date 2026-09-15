CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('authorization', 'credential_issued', 'credential_revoked', 'tool_invocation')),
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_id TEXT,
  agent_id TEXT,
  tool_id TEXT,
  credential_id UUID,
  allowed BOOLEAN,
  rationale TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_events_correlation_idx ON audit_events (correlation_id);
CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events (occurred_at);
CREATE INDEX IF NOT EXISTS audit_events_agent_idx ON audit_events (agent_id);
