-- Append-only supplemental evidence for completed Driver physical visits.

CREATE TABLE IF NOT EXISTS driver_job_photo_addition_events (
  id bigserial PRIMARY KEY,
  addition_event_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE,
  actor_operator_id text NOT NULL,
  actor_name text NOT NULL,
  driver_login text NOT NULL,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE RESTRICT,
  plan_date date NOT NULL,
  primary_driver_job_record_id bigint NOT NULL REFERENCES driver_job_records(id) ON DELETE RESTRICT,
  primary_job_id text NOT NULL,
  physical_visit_record_ids jsonb NOT NULL,
  physical_visit_job_ids jsonb NOT NULL,
  stop_type text NOT NULL,
  photo_references jsonb NOT NULL,
  photo_descriptors jsonb NOT NULL,
  reason text NOT NULL,
  before_photo_count integer NOT NULL,
  after_photo_count integer NOT NULL,
  expected_state_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_job_photo_addition_actor_not_blank CHECK (
    NULLIF(btrim(actor_operator_id), '') IS NOT NULL
    AND NULLIF(btrim(actor_name), '') IS NOT NULL
  ),
  CONSTRAINT driver_job_photo_addition_driver_not_blank
    CHECK (NULLIF(btrim(driver_login), '') IS NOT NULL),
  CONSTRAINT driver_job_photo_addition_primary_not_blank
    CHECK (NULLIF(btrim(primary_job_id), '') IS NOT NULL),
  CONSTRAINT driver_job_photo_addition_record_ids_array CHECK (
    jsonb_typeof(physical_visit_record_ids) = 'array'
    AND jsonb_array_length(physical_visit_record_ids) > 0
  ),
  CONSTRAINT driver_job_photo_addition_job_ids_array CHECK (
    jsonb_typeof(physical_visit_job_ids) = 'array'
    AND jsonb_array_length(physical_visit_job_ids) > 0
  ),
  CONSTRAINT driver_job_photo_addition_stop_type CHECK (stop_type IN ('pickup', 'dropoff')),
  CONSTRAINT driver_job_photo_addition_references_array CHECK (
    jsonb_typeof(photo_references) = 'array'
    AND jsonb_array_length(photo_references) > 0
  ),
  CONSTRAINT driver_job_photo_addition_descriptors_array CHECK (
    jsonb_typeof(photo_descriptors) = 'array'
    AND jsonb_array_length(photo_descriptors) = jsonb_array_length(photo_references)
  ),
  CONSTRAINT driver_job_photo_addition_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT driver_job_photo_addition_counts CHECK (
    before_photo_count >= 0
    AND after_photo_count > before_photo_count
    AND after_photo_count <= 20
  ),
  CONSTRAINT driver_job_photo_addition_state_hash CHECK (expected_state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_job_photo_addition_result_object CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_driver_job_photo_addition_driver_day
  ON driver_job_photo_addition_events (lower(driver_login), plan_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_job_photo_addition_primary_record
  ON driver_job_photo_addition_events (primary_driver_job_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_job_records_dispatch_visit_filter
  ON driver_job_records (plan_date DESC, status, lower(driver_login), lower(stop_type), id DESC);

DROP TRIGGER IF EXISTS trg_driver_job_photo_addition_events_immutable
  ON driver_job_photo_addition_events;
CREATE TRIGGER trg_driver_job_photo_addition_events_immutable
  BEFORE UPDATE OR DELETE ON driver_job_photo_addition_events
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

COMMENT ON TABLE driver_job_photo_addition_events IS
  'Append-only dispatcher attribution and idempotency ledger for photos added to a completed Driver physical visit.';
