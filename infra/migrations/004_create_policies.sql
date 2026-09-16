CREATE TABLE IF NOT EXISTS policies (
  policy_id TEXT PRIMARY KEY,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  tool_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL DEFAULT 'invoke',
  reason TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policies_lookup_idx
  ON policies (tool_id, action, actor_id, status);
