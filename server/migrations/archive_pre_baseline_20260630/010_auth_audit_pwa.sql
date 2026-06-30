CREATE TABLE IF NOT EXISTS operators (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  role text NOT NULL DEFAULT 'operator',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operators_role_check CHECK (role IN ('operator', 'admin'))
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_audit_log (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL DEFAULT 'operator',
  actor_operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'delivery',
  action text NOT NULL,
  order_id bigint REFERENCES delivery_orders(netsuite_id) ON DELETE SET NULL,
  line_id bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator
  ON operator_sessions (operator_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_audit_log_order
  ON delivery_audit_log (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_audit_log_actor
  ON delivery_audit_log (actor_operator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_audit_log_action
  ON delivery_audit_log (action, created_at DESC);
