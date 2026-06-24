CREATE TABLE IF NOT EXISTS dispatch_plans (
  id bigserial PRIMARY KEY,
  plan_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  revised_from_plan_id bigint REFERENCES dispatch_plans(id),
  note text,
  created_by bigint,
  confirmed_by bigint,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_plans_date_status_version
  ON dispatch_plans (plan_date, status, version);

CREATE INDEX IF NOT EXISTS idx_dispatch_plans_date
  ON dispatch_plans (plan_date DESC, version DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_plans_status
  ON dispatch_plans (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_plan_snapshots (
  plan_id bigint PRIMARY KEY REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  trucks jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  saved_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dispatch_audit_log
  ADD COLUMN IF NOT EXISTS plan_id bigint REFERENCES dispatch_plans(id),
  ADD COLUMN IF NOT EXISTS plan_date date;

CREATE INDEX IF NOT EXISTS idx_dispatch_audit_log_plan
  ON dispatch_audit_log (plan_id, created_at DESC);
