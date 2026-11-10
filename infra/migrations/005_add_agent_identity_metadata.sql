ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS identity_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
