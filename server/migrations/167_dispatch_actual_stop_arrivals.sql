CREATE TABLE IF NOT EXISTS dispatch_actual_arrival_runs (
  run_id uuid PRIMARY KEY,
  run_mode text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  plan_date date NOT NULL,
  driver_login text NOT NULL,
  trigger_job_record_id bigint REFERENCES driver_job_records(id) ON DELETE RESTRICT,
  trigger_completed_at timestamptz,
  requested_by text NOT NULL,
  algorithm_version text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  result_version bigint NOT NULL DEFAULT 0,
  total_stops integer NOT NULL DEFAULT 0,
  resolved_stops integer NOT NULL DEFAULT 0,
  unresolved_stops integer NOT NULL DEFAULT 0,
  skipped_stops integer NOT NULL DEFAULT 0,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  preview_ready_at timestamptz,
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_actual_arrival_runs_mode_valid
    CHECK (run_mode IN ('automatic', 'historical')),
  CONSTRAINT dispatch_actual_arrival_runs_status_valid
    CHECK (status IN (
      'queued', 'running', 'retry_wait', 'preview_ready', 'applied',
      'failed', 'needs_review', 'suppressed_gate_off', 'stale'
    )),
  CONSTRAINT dispatch_actual_arrival_runs_driver_not_blank
    CHECK (btrim(driver_login) <> ''),
  CONSTRAINT dispatch_actual_arrival_runs_actor_not_blank
    CHECK (btrim(requested_by) <> ''),
  CONSTRAINT dispatch_actual_arrival_runs_attempt_nonnegative
    CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_actual_arrival_auto_completion
  ON dispatch_actual_arrival_runs (trigger_job_record_id, trigger_completed_at)
  WHERE run_mode = 'automatic' AND trigger_job_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_actual_arrival_runs_worker
  ON dispatch_actual_arrival_runs (next_attempt_at, created_at)
  WHERE status IN ('queued', 'retry_wait', 'running');

CREATE INDEX IF NOT EXISTS idx_dispatch_actual_arrival_runs_driver_day
  ON dispatch_actual_arrival_runs (plan_date DESC, lower(driver_login), created_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_actual_arrival_run_stops (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES dispatch_actual_arrival_runs(run_id) ON DELETE CASCADE,
  visit_key text NOT NULL,
  sequence_no integer NOT NULL,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  load_id text NOT NULL DEFAULT '',
  load_name text NOT NULL DEFAULT '',
  stop_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  order_refs text[] NOT NULL DEFAULT ARRAY[]::text[],
  driver_job_record_ids bigint[] NOT NULL,
  truck_plate text NOT NULL DEFAULT '',
  destination_address text NOT NULL DEFAULT '',
  destination_latitude double precision,
  destination_longitude double precision,
  previous_completed_at timestamptz,
  pwa_started_at timestamptz,
  completed_at timestamptz,
  existing_arrival_at timestamptz,
  proposed_arrival_at timestamptz,
  resolution_status text NOT NULL,
  source text NOT NULL DEFAULT '',
  confidence text NOT NULL DEFAULT '',
  state_hash text NOT NULL,
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_actual_arrival_run_stops_status_valid
    CHECK (resolution_status IN ('resolved', 'first_stop', 'same_site', 'unresolved')),
  CONSTRAINT dispatch_actual_arrival_run_stops_hash_valid
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT dispatch_actual_arrival_run_stops_records_present
    CHECK (cardinality(driver_job_record_ids) > 0),
  UNIQUE (run_id, visit_key)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_actual_arrival_run_stops_run_sequence
  ON dispatch_actual_arrival_run_stops (run_id, sequence_no);

CREATE TABLE IF NOT EXISTS dispatch_actual_stop_arrivals (
  driver_job_record_id bigint PRIMARY KEY REFERENCES driver_job_records(id) ON DELETE RESTRICT,
  visit_key text NOT NULL,
  actual_arrival_at timestamptz NOT NULL,
  source text NOT NULL,
  confidence text NOT NULL,
  algorithm_version text NOT NULL,
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_run_id uuid NOT NULL REFERENCES dispatch_actual_arrival_runs(run_id) ON DELETE RESTRICT,
  applied_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_actual_stop_arrivals_source_not_blank CHECK (btrim(source) <> ''),
  CONSTRAINT dispatch_actual_stop_arrivals_actor_not_blank CHECK (btrim(applied_by) <> '')
);

CREATE INDEX IF NOT EXISTS idx_dispatch_actual_stop_arrivals_visit
  ON dispatch_actual_stop_arrivals (visit_key, actual_arrival_at);

CREATE OR REPLACE FUNCTION dispatch_queue_actual_arrival_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  physical_job_ids jsonb;
  lead_job_id text;
BEGIN
  IF NEW.status <> 'complete'
     OR lower(COALESCE(NEW.stop_type, '')) NOT IN ('pickup', 'dropoff')
     OR NEW.completed_at IS NULL
     OR NEW.plan_date IS NULL
     OR btrim(COALESCE(NEW.driver_login, '')) = '' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'complete'
     AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at THEN
    RETURN NEW;
  END IF;

  physical_job_ids := COALESCE(NEW.job_details->'physicalVisitJobIds', '[]'::jsonb);
  lead_job_id := CASE
    WHEN jsonb_typeof(physical_job_ids) = 'array' AND jsonb_array_length(physical_job_ids) > 0
      THEN physical_job_ids->>0
    ELSE ''
  END;
  IF lead_job_id <> '' AND lead_job_id <> NEW.job_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO dispatch_actual_arrival_runs (
    run_id, run_mode, status, plan_date, driver_login,
    trigger_job_record_id, trigger_completed_at, requested_by,
    algorithm_version, next_attempt_at
  ) VALUES (
    gen_random_uuid(), 'automatic', 'queued', NEW.plan_date, lower(btrim(NEW.driver_login)),
    NEW.id, NEW.completed_at, 'system:driver-completion',
    'terminal-cluster-v1', now()
  )
  ON CONFLICT (trigger_job_record_id, trigger_completed_at)
    WHERE run_mode = 'automatic' AND trigger_job_record_id IS NOT NULL
  DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_job_queue_actual_arrival ON driver_job_records;
CREATE TRIGGER trg_driver_job_queue_actual_arrival
  AFTER INSERT OR UPDATE OF status, completed_at ON driver_job_records
  FOR EACH ROW EXECUTE FUNCTION dispatch_queue_actual_arrival_run();

COMMENT ON TABLE dispatch_actual_stop_arrivals IS
  'Canonical derived physical-stop arrivals. Driver PWA started_at and completed_at remain unchanged.';
COMMENT ON TABLE dispatch_actual_arrival_run_stops IS
  'Immutable calculation preview/evidence rows for automatic and dispatcher-requested arrival runs.';
