CREATE TABLE IF NOT EXISTS operator_record_warnings (
  id bigserial PRIMARY KEY,
  operator_id text REFERENCES operators(id) ON DELETE SET NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  reference text,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by text REFERENCES operators(id) ON DELETE SET NULL,
  handled_at timestamptz,
  resolution text,
  CONSTRAINT operator_record_warnings_status_check CHECK (status IN ('open', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_operator_record_warnings_status
  ON operator_record_warnings (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_record_warnings_operator
  ON operator_record_warnings (operator_id, created_at DESC);
