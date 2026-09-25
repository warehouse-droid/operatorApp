-- Small, coalesced intentions only. The latest authoritative orders are read
-- when work runs; no stale plan payload is replayed by this queue.
CREATE TABLE IF NOT EXISTS dispatch_plan_maintenance (
  plan_id bigint PRIMARY KEY REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  requests jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(requests) = 'object'),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispatch_plan_maintenance_due
  ON dispatch_plan_maintenance (available_at, plan_id);
