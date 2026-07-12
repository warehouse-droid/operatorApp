CREATE TABLE IF NOT EXISTS dispatch_plan_snapshot_history (
  id bigserial PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  plan_date date NOT NULL,
  revision bigint,
  orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  trucks jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_saved_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archive_reason text NOT NULL DEFAULT 'before_save',
  session_id text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_snapshot_history_plan
  ON dispatch_plan_snapshot_history (plan_id, archived_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_snapshot_history_date
  ON dispatch_plan_snapshot_history (plan_date DESC, archived_at DESC);

