CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scope TEXT[] NOT NULL CHECK (cardinality(scope) BETWEEN 1 AND 20),
  secret_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at <= created_at + INTERVAL '1 hour')
);

CREATE INDEX IF NOT EXISTS credentials_agent_id_idx ON credentials (agent_id);
CREATE INDEX IF NOT EXISTS credentials_expires_at_idx ON credentials (expires_at);
