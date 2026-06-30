ALTER TABLE driver_job_records
  ALTER COLUMN completed_at DROP NOT NULL;

ALTER TABLE driver_job_records
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

UPDATE driver_job_records
   SET started_at = COALESCE(started_at, completed_at, created_at)
 WHERE status = 'complete';

CREATE INDEX IF NOT EXISTS idx_driver_job_records_plan_load_stop
  ON driver_job_records (plan_id, load_id, stop_id, status);
