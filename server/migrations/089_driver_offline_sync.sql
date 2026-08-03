CREATE TABLE IF NOT EXISTS driver_sessions (
  session_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  driver_login text NOT NULL,
  device_id text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT driver_sessions_login_not_blank CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_sessions_token_hash_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_driver_sessions_login_active
  ON driver_sessions (lower(driver_login), expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS driver_offline_manifests (
  manifest_id uuid PRIMARY KEY,
  schema_version integer NOT NULL DEFAULT 1,
  fingerprint_version integer NOT NULL DEFAULT 1,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  plan_date date NOT NULL,
  plan_revision bigint NOT NULL DEFAULT 0,
  driver_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  day_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  samsara_workflow_enabled boolean NOT NULL DEFAULT false,
  complete boolean NOT NULL DEFAULT false,
  job_count integer NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  superseded_at timestamptz,
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_offline_manifests_login_not_blank CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_offline_manifests_device_not_blank CHECK (btrim(device_id) <> ''),
  CONSTRAINT driver_offline_manifests_job_count_nonnegative CHECK (job_count >= 0),
  CONSTRAINT driver_offline_manifests_expiry_after_generation CHECK (expires_at > generated_at)
);

CREATE INDEX IF NOT EXISTS idx_driver_offline_manifests_driver_day
  ON driver_offline_manifests (lower(driver_login), plan_date DESC, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_driver_offline_manifests_device_day
  ON driver_offline_manifests (device_id, plan_date DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS driver_offline_manifest_jobs (
  id bigserial PRIMARY KEY,
  manifest_id uuid NOT NULL REFERENCES driver_offline_manifests(manifest_id) ON DELETE CASCADE,
  sequence_index integer NOT NULL,
  original_job_id text NOT NULL,
  assigned_driver_login text NOT NULL,
  job_fingerprint text NOT NULL,
  predecessor_fingerprint text NOT NULL,
  required_photo_count integer NOT NULL DEFAULT 0,
  job_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_offline_manifest_jobs_sequence_nonnegative CHECK (sequence_index >= 0),
  CONSTRAINT driver_offline_manifest_jobs_job_not_blank CHECK (btrim(original_job_id) <> ''),
  CONSTRAINT driver_offline_manifest_jobs_driver_not_blank CHECK (btrim(assigned_driver_login) <> ''),
  CONSTRAINT driver_offline_manifest_jobs_fingerprint_sha256 CHECK (job_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_offline_manifest_jobs_predecessor_not_blank CHECK (btrim(predecessor_fingerprint) <> ''),
  CONSTRAINT driver_offline_manifest_jobs_required_photos_nonnegative CHECK (required_photo_count >= 0),
  CONSTRAINT driver_offline_manifest_jobs_manifest_sequence_unique UNIQUE (manifest_id, sequence_index),
  CONSTRAINT driver_offline_manifest_jobs_manifest_job_unique UNIQUE (manifest_id, original_job_id)
);

CREATE INDEX IF NOT EXISTS idx_driver_offline_manifest_jobs_fingerprint
  ON driver_offline_manifest_jobs (job_fingerprint, predecessor_fingerprint);

CREATE TABLE IF NOT EXISTS driver_offline_sync_grants (
  grant_id uuid PRIMARY KEY,
  manifest_id uuid NOT NULL REFERENCES driver_offline_manifests(manifest_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  plan_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT driver_offline_sync_grants_login_not_blank CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_offline_sync_grants_device_not_blank CHECK (btrim(device_id) <> ''),
  CONSTRAINT driver_offline_sync_grants_token_hash_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_offline_sync_grants_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_driver_offline_sync_grants_manifest_active
  ON driver_offline_sync_grants (manifest_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS driver_offline_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  manifest_id uuid NOT NULL REFERENCES driver_offline_manifests(manifest_id) ON DELETE RESTRICT,
  manifest_job_id bigint REFERENCES driver_offline_manifest_jobs(id) ON DELETE RESTRICT,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  plan_date date NOT NULL,
  client_sequence bigint NOT NULL,
  event_type text NOT NULL,
  original_job_id text,
  effective_job_id text,
  job_fingerprint text,
  predecessor_fingerprint text,
  device_occurred_at timestamptz NOT NULL,
  device_occurred_at_raw text NOT NULL,
  occurrence_time_valid boolean NOT NULL DEFAULT true,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  server_applied_at timestamptz,
  location_status text NOT NULL DEFAULT 'not_checked_offline',
  location_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  immutable_payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'registered',
  review_reason text NOT NULL DEFAULT '',
  application_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  case_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_offline_events_login_not_blank CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_offline_events_device_not_blank CHECK (btrim(device_id) <> ''),
  CONSTRAINT driver_offline_events_sequence_positive CHECK (client_sequence > 0),
  CONSTRAINT driver_offline_events_type_valid CHECK (
    event_type IN (
      'job_started',
      'job_completed',
      'rest_started',
      'rest_ended',
      'truck_switched_physical',
      'dvir_captured'
    )
  ),
  CONSTRAINT driver_offline_events_location_valid CHECK (
    location_status IN (
      'not_checked_offline',
      'verified',
      'warning_overridden',
      'not_required'
    )
  ),
  CONSTRAINT driver_offline_events_status_valid CHECK (
    status IN (
      'registered',
      'waiting_photos',
      'pending',
      'applying',
      'applied',
      'review_required',
      'blocked',
      'resolution_pending',
      'evidence_only',
      'rejected'
    )
  ),
  CONSTRAINT driver_offline_events_payload_hash_sha256 CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_offline_events_case_version_positive CHECK (case_version > 0),
  CONSTRAINT driver_offline_events_device_sequence_unique UNIQUE (driver_login, device_id, client_sequence)
);

ALTER TABLE driver_offline_events
  ADD COLUMN IF NOT EXISTS device_occurred_at_raw text,
  ADD COLUMN IF NOT EXISTS occurrence_time_valid boolean NOT NULL DEFAULT true;

UPDATE driver_offline_events
   SET device_occurred_at_raw = COALESCE(
     NULLIF(device_occurred_at_raw, ''),
     to_char(device_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   )
 WHERE device_occurred_at_raw IS NULL
    OR device_occurred_at_raw = '';

ALTER TABLE driver_offline_events
  ALTER COLUMN device_occurred_at_raw SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_offline_events_driver_day_sequence
  ON driver_offline_events (lower(driver_login), plan_date, client_sequence);

CREATE INDEX IF NOT EXISTS idx_driver_offline_events_review
  ON driver_offline_events (server_received_at, id)
  WHERE status = 'review_required';

CREATE INDEX IF NOT EXISTS idx_driver_offline_events_manifest_status
  ON driver_offline_events (manifest_id, status, client_sequence);

CREATE TABLE IF NOT EXISTS driver_offline_event_photos (
  id bigserial PRIMARY KEY,
  photo_id uuid NOT NULL UNIQUE,
  event_record_id bigint NOT NULL REFERENCES driver_offline_events(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL,
  record_type text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  descriptor_hash text NOT NULL,
  status text NOT NULL DEFAULT 'registered',
  object_reference text,
  uploaded_at timestamptz,
  durable_received_at timestamptz,
  durable_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_offline_event_photos_ordinal_nonnegative CHECK (ordinal >= 0),
  CONSTRAINT driver_offline_event_photos_record_type_not_blank CHECK (btrim(record_type) <> ''),
  CONSTRAINT driver_offline_event_photos_mime_jpeg CHECK (lower(mime_type) IN ('image/jpeg', 'image/jpg')),
  CONSTRAINT driver_offline_event_photos_byte_size_valid CHECK (byte_size > 0 AND byte_size <= 2097152),
  CONSTRAINT driver_offline_event_photos_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_offline_event_photos_descriptor_hash CHECK (descriptor_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT driver_offline_event_photos_status_valid CHECK (
    status IN ('registered', 'uploading', 'uploaded_unverified', 'durably_received', 'rejected')
  ),
  CONSTRAINT driver_offline_event_photos_event_ordinal_unique UNIQUE (event_record_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_driver_offline_event_photos_event_status
  ON driver_offline_event_photos (event_record_id, status, ordinal);

CREATE TABLE IF NOT EXISTS driver_offline_resolutions (
  id bigserial PRIMARY KEY,
  resolution_id uuid NOT NULL UNIQUE,
  event_record_id bigint NOT NULL UNIQUE REFERENCES driver_offline_events(id) ON DELETE RESTRICT,
  idempotency_id uuid NOT NULL UNIQUE,
  case_version integer NOT NULL,
  action text NOT NULL,
  target_job_id text,
  audit_note text NOT NULL,
  resolved_by text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_offline_resolutions_case_version_positive CHECK (case_version > 0),
  CONSTRAINT driver_offline_resolutions_action_valid CHECK (
    action IN ('apply_original', 'reattach', 'evidence_only')
  ),
  CONSTRAINT driver_offline_resolutions_note_not_blank CHECK (btrim(audit_note) <> ''),
  CONSTRAINT driver_offline_resolutions_actor_not_blank CHECK (btrim(resolved_by) <> ''),
  CONSTRAINT driver_offline_resolutions_reattach_target CHECK (
    action <> 'reattach' OR btrim(COALESCE(target_job_id, '')) <> ''
  )
);

CREATE TABLE IF NOT EXISTS driver_location_verifications (
  verification_id uuid PRIMARY KEY,
  driver_login text NOT NULL,
  device_id text NOT NULL DEFAULT '',
  job_id text NOT NULL,
  status text NOT NULL,
  source text NOT NULL DEFAULT 'samsara',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_event_id uuid REFERENCES driver_offline_events(event_id) ON DELETE SET NULL,
  CONSTRAINT driver_location_verifications_login_not_blank CHECK (btrim(driver_login) <> ''),
  CONSTRAINT driver_location_verifications_job_not_blank CHECK (btrim(job_id) <> ''),
  CONSTRAINT driver_location_verifications_status_valid CHECK (
    status IN ('verified', 'warning', 'unavailable', 'override_allowed')
  ),
  CONSTRAINT driver_location_verifications_source_valid CHECK (
    source IN ('samsara', 'server_override')
  ),
  CONSTRAINT driver_location_verifications_expiry_after_check CHECK (expires_at > checked_at)
);

CREATE INDEX IF NOT EXISTS idx_driver_location_verifications_lookup
  ON driver_location_verifications (lower(driver_login), job_id, expires_at DESC);

ALTER TABLE driver_job_records
  ADD COLUMN IF NOT EXISTS source_offline_event_id uuid REFERENCES driver_offline_events(event_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS device_occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_status text,
  ADD COLUMN IF NOT EXISTS location_details jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE driver_rest_records
  ADD COLUMN IF NOT EXISTS source_offline_event_id uuid REFERENCES driver_offline_events(event_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS device_occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_status text,
  ADD COLUMN IF NOT EXISTS location_details jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE driver_truck_switch_records
  ADD COLUMN IF NOT EXISTS source_offline_event_id uuid REFERENCES driver_offline_events(event_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS device_occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS server_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_status text,
  ADD COLUMN IF NOT EXISTS location_details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_driver_job_records_offline_event
  ON driver_job_records (source_offline_event_id)
  WHERE source_offline_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_rest_records_offline_event
  ON driver_rest_records (source_offline_event_id)
  WHERE source_offline_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_truck_switch_records_offline_event
  ON driver_truck_switch_records (source_offline_event_id)
  WHERE source_offline_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbbs_driver_offline_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_offline_manifest_jobs_immutable
  ON driver_offline_manifest_jobs;
CREATE TRIGGER trg_driver_offline_manifest_jobs_immutable
  BEFORE UPDATE ON driver_offline_manifest_jobs
  FOR EACH ROW EXECUTE FUNCTION mbbs_driver_offline_immutable_row();

DROP TRIGGER IF EXISTS trg_driver_offline_resolutions_immutable
  ON driver_offline_resolutions;
CREATE TRIGGER trg_driver_offline_resolutions_immutable
  BEFORE UPDATE OR DELETE ON driver_offline_resolutions
  FOR EACH ROW EXECUTE FUNCTION mbbs_driver_offline_immutable_row();

COMMENT ON TABLE driver_offline_manifest_jobs IS
  'Immutable, driver-only operational snapshots used to validate and rebase deferred Driver PWA events.';

COMMENT ON COLUMN driver_offline_events.immutable_payload IS
  'Canonical client event identity. Upload/object references are deliberately excluded so resumable uploads do not change idempotency.';

COMMENT ON COLUMN driver_offline_events.device_occurred_at IS
  'Untrusted device occurrence time retained separately from server receipt and application time.';
