CREATE TABLE IF NOT EXISTS dispatch_audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  order_id text,
  load_id text,
  truck_id text,
  session_id text,
  operator_id bigint,
  operator_name text,
  source text NOT NULL DEFAULT 'dispatch',
  before_state jsonb,
  after_state jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_audit_log_created
  ON dispatch_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_audit_log_action
  ON dispatch_audit_log (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_audit_log_order
  ON dispatch_audit_log (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_audit_log_load
  ON dispatch_audit_log (load_id, created_at DESC);
