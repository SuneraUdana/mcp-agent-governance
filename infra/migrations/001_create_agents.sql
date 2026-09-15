CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 100),
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 1000),
  risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agents_status_idx ON agents (status);
CREATE INDEX IF NOT EXISTS agents_owner_id_idx ON agents (owner_id);
