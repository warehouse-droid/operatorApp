CREATE TABLE IF NOT EXISTS dispatch_plan_edit_leases (
  plan_date date PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  operator_name text NOT NULL DEFAULT '',
  session_id text NOT NULL,
  token_hash text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_edit_leases_expiry
  ON dispatch_plan_edit_leases (expires_at);
