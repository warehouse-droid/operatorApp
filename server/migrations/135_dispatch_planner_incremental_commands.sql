ALTER TABLE dispatch_plan_snapshots
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS plan_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS order_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS truck_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS load_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_count integer NOT NULL DEFAULT 0;

ALTER TABLE dispatch_plan_snapshot_history
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS plan_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS order_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS truck_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS load_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS dispatch_plan_commands (
  id bigserial PRIMARY KEY,
  command_id text NOT NULL,
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  plan_date date NOT NULL,
  command_type text NOT NULL,
  request_hash text NOT NULL,
  base_revision bigint NOT NULL,
  applied_revision bigint NOT NULL,
  session_id text NOT NULL DEFAULT '',
  actor_id text,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_plan_commands_command_id_unique UNIQUE (command_id),
  CONSTRAINT dispatch_plan_commands_plan_revision_unique UNIQUE (plan_id, applied_revision)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_commands_plan_created
  ON dispatch_plan_commands (plan_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_plan_order_assignments (
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  plan_date date NOT NULL,
  order_ref text NOT NULL,
  load_id text NOT NULL DEFAULT '',
  stop_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, order_ref)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_order_assignments_ref_date
  ON dispatch_plan_order_assignments (lower(order_ref), plan_date);

CREATE TABLE IF NOT EXISTS dispatch_plan_followup_outbox (
  id bigserial PRIMARY KEY,
  command_id text NOT NULL REFERENCES dispatch_plan_commands(command_id) ON DELETE CASCADE,
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  command_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text NOT NULL DEFAULT '',
  available_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_plan_followup_outbox_command_unique UNIQUE (command_id),
  CONSTRAINT dispatch_plan_followup_outbox_status_check
    CHECK (status IN ('pending', 'running', 'complete', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_plan_followup_outbox_pending
  ON dispatch_plan_followup_outbox (available_at, id)
  WHERE status IN ('pending', 'failed');

-- Existing snapshots are intentionally not rewritten here. Metadata is filled
-- on the next save/command so deployment never performs a multi-gigabyte JSON
-- rewrite while Dispatch is live.
