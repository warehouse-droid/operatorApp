CREATE TABLE IF NOT EXISTS netsuite_delayed_status_refresh_jobs (
  id bigserial PRIMARY KEY,
  order_type text NOT NULL CHECK (order_type IN ('sales_order', 'purchase_order')),
  netsuite_order_id bigint NOT NULL CHECK (netsuite_order_id > 0),
  tranid text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS netsuite_delayed_status_refresh_jobs_active_identity_idx
  ON netsuite_delayed_status_refresh_jobs (order_type, netsuite_order_id)
  WHERE status IN ('pending', 'running', 'retry');

CREATE INDEX IF NOT EXISTS netsuite_delayed_status_refresh_jobs_due_idx
  ON netsuite_delayed_status_refresh_jobs (available_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS netsuite_delayed_status_refresh_jobs_expired_lease_idx
  ON netsuite_delayed_status_refresh_jobs (lease_expires_at, id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS netsuite_delayed_status_refresh_attempts (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES netsuite_delayed_status_refresh_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  lease_token uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running', 'succeeded', 'retry', 'failed', 'lease_expired')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (job_id, attempt_number),
  UNIQUE (lease_token),
  CHECK (
    (outcome = 'running' AND finished_at IS NULL)
    OR
    (outcome <> 'running' AND finished_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS netsuite_delayed_status_refresh_attempts_job_idx
  ON netsuite_delayed_status_refresh_attempts (job_id, attempt_number);

COMMENT ON TABLE netsuite_delayed_status_refresh_jobs IS
  'Durable webhook-triggered NetSuite status refresh work. This is not a global pending-order polling queue.';

COMMENT ON TABLE netsuite_delayed_status_refresh_attempts IS
  'Authoritative per-claim execution evidence for delayed NetSuite status refresh jobs.';
