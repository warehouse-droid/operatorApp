ALTER TABLE driver_offline_event_photos
  ADD COLUMN IF NOT EXISTS verification_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_verification_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_verification_error_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_verification_error text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'driver_offline_event_photos_verification_attempt_count_nonnegative'
       AND conrelid = 'driver_offline_event_photos'::regclass
  ) THEN
    ALTER TABLE driver_offline_event_photos
      ADD CONSTRAINT driver_offline_event_photos_verification_attempt_count_nonnegative
      CHECK (verification_attempt_count >= 0);
  END IF;
END $$;

COMMENT ON COLUMN driver_offline_event_photos.verification_attempt_count IS
  'Number of server durability/read-back attempts, including explicit Dispatcher retries.';

COMMENT ON COLUMN driver_offline_event_photos.last_verification_error IS
  'Last safe durability/read-back failure shown to Dispatch; cleared after durable verification.';

CREATE TABLE IF NOT EXISTS driver_offline_retry_attempts (
  id bigserial PRIMARY KEY,
  retry_id uuid NOT NULL UNIQUE,
  event_record_id bigint NOT NULL REFERENCES driver_offline_events(id) ON DELETE RESTRICT,
  case_version integer NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'executing',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_offline_retry_attempts_case_version_positive CHECK (case_version > 0),
  CONSTRAINT driver_offline_retry_attempts_actor_not_blank CHECK (btrim(requested_by) <> ''),
  CONSTRAINT driver_offline_retry_attempts_status_valid CHECK (
    status IN ('executing', 'completed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_driver_offline_retry_attempts_event
  ON driver_offline_retry_attempts (event_record_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_offline_retry_attempts_executing
  ON driver_offline_retry_attempts (event_record_id, updated_at)
  WHERE status = 'executing';
