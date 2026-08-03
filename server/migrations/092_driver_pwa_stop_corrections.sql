CREATE TABLE IF NOT EXISTS driver_job_corrections (
  id bigserial PRIMARY KEY,
  correction_id uuid NOT NULL UNIQUE,
  idempotency_id uuid NOT NULL UNIQUE,
  action text NOT NULL,
  driver_job_record_id bigint NOT NULL REFERENCES driver_job_records(id) ON DELETE RESTRICT,
  job_id text NOT NULL,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  plan_date date NOT NULL,
  driver_login text NOT NULL,
  load_id text NOT NULL DEFAULT '',
  stop_id text NOT NULL DEFAULT '',
  stop_type text NOT NULL DEFAULT '',
  target_job_id text NOT NULL DEFAULT '',
  target_location text NOT NULL DEFAULT '',
  expected_state_hash text NOT NULL,
  audit_note text NOT NULL,
  corrected_by text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_job_corrections_action_valid
    CHECK (action IN ('reopen', 'map_location')),
  CONSTRAINT driver_job_corrections_job_not_blank
    CHECK (btrim(job_id) <> ''),
  CONSTRAINT driver_job_corrections_driver_not_blank
    CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_job_corrections_hash_sha256
    CHECK (expected_state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_job_corrections_note_not_blank
    CHECK (btrim(audit_note) <> ''),
  CONSTRAINT driver_job_corrections_actor_not_blank
    CHECK (btrim(corrected_by) <> '')
);

CREATE INDEX IF NOT EXISTS idx_driver_job_corrections_driver_day
  ON driver_job_corrections (lower(driver_login), plan_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_job_corrections_job
  ON driver_job_corrections (job_id, created_at DESC);

COMMENT ON TABLE driver_job_corrections IS
  'Immutable evidence ledger for Dispatcher corrections and guarded reopen actions on Driver PWA stop records.';

DROP TRIGGER IF EXISTS trg_driver_job_corrections_immutable
  ON driver_job_corrections;
CREATE TRIGGER trg_driver_job_corrections_immutable
  BEFORE UPDATE OR DELETE ON driver_job_corrections
  FOR EACH ROW EXECUTE FUNCTION mbbs_driver_offline_immutable_row();
