-- MBT Phase 2 sandbox-only NetSuite readiness evidence.
-- This migration adds no credential, scheduler, transaction probe, outbox,
-- feature-flag activation, or operational NetSuite write capability.

ALTER TABLE mbt_netsuite_preflight_runs
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS runtime_fingerprint text NOT NULL DEFAULT repeat('0', 64);

-- Retained schema-107 evidence and the still-supported Phase 1 read-only path
-- predate runtime binding. A reserved all-zero fingerprint keeps both
-- explicitly non-current; Phase 2 signoff rejects this reserved value.
ALTER TABLE mbt_netsuite_preflight_runs
  ALTER COLUMN runtime_fingerprint SET DEFAULT repeat('0', 64),
  ALTER COLUMN runtime_fingerprint SET NOT NULL;
ALTER TABLE mbt_netsuite_preflight_runs
  DROP CONSTRAINT IF EXISTS mbt_netsuite_preflight_runs_runtime_sha256;
ALTER TABLE mbt_netsuite_preflight_runs
  ADD CONSTRAINT mbt_netsuite_preflight_runs_runtime_sha256
    CHECK (runtime_fingerprint ~ '^[0-9a-f]{64}$');

-- Schema 107 allowed queued states but did not provide a durable lease. Close
-- any such legacy rows explicitly before requiring the Phase 2 lease envelope.
-- No terminal evidence is rewritten or deleted.
UPDATE mbt_netsuite_preflight_runs
   SET status = 'unable_to_verify',
       failed_required_count = GREATEST(
         failed_required_count,
         required_check_count - passed_required_count
       ),
       completed_at = COALESCE(completed_at, clock_timestamp()),
       error_code = COALESCE(error_code, 'MBT_NETSUITE_PREFLIGHT_LEGACY_RUN_CLOSED'),
       error_message = COALESCE(
         NULLIF(error_message, ''),
         'A pre-Phase 2 preflight had no durable lease and was safely closed during migration.'
       ),
       updated_at = clock_timestamp(),
       lease_token = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE status IN ('pending', 'running');

ALTER TABLE mbt_netsuite_preflight_runs
  DROP CONSTRAINT IF EXISTS mbt_netsuite_preflight_runs_adapter;
ALTER TABLE mbt_netsuite_preflight_runs
  ADD CONSTRAINT mbt_netsuite_preflight_runs_adapter
    CHECK (adapter_kind IN ('phase1_read_only_fake', 'read_only_sandbox'))
    NOT VALID;

ALTER TABLE mbt_netsuite_preflight_runs
  DROP CONSTRAINT IF EXISTS mbt_netsuite_preflight_runs_lease_complete;
ALTER TABLE mbt_netsuite_preflight_runs
  ADD CONSTRAINT mbt_netsuite_preflight_runs_lease_complete
    CHECK (
      (
        status IN ('pending', 'running')
        AND lease_token IS NOT NULL
        AND NULLIF(btrim(COALESCE(lease_owner, '')), '') IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
      OR
      (
        status NOT IN ('pending', 'running')
        AND lease_token IS NULL
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_netsuite_preflight_one_active
  ON mbt_netsuite_preflight_runs ((true))
  WHERE status IN ('pending', 'running');

ALTER TABLE mbt_netsuite_preflight_checks
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'error';

ALTER TABLE mbt_netsuite_preflight_checks
  DROP CONSTRAINT IF EXISTS mbt_netsuite_preflight_checks_severity;
ALTER TABLE mbt_netsuite_preflight_checks
  ADD CONSTRAINT mbt_netsuite_preflight_checks_severity
    CHECK (severity IN ('error', 'warning', 'info'));

CREATE TABLE IF NOT EXISTS mbt_netsuite_preflight_signoffs (
  signoff_id uuid PRIMARY KEY,
  preflight_run_id uuid NOT NULL
    REFERENCES mbt_netsuite_preflight_runs(preflight_run_id) ON DELETE RESTRICT,
  configuration_hash text NOT NULL,
  runtime_fingerprint text NOT NULL,
  signed_by text NOT NULL,
  audit_note text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL,
  request_id text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT mbt_netsuite_preflight_signoffs_run_unique
    UNIQUE (preflight_run_id),
  CONSTRAINT mbt_netsuite_preflight_signoffs_hash_sha256
    CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_netsuite_preflight_signoffs_runtime_sha256
    CHECK (runtime_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_netsuite_preflight_signoffs_signed_by_not_blank
    CHECK (NULLIF(btrim(signed_by), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_signoffs_note_not_blank
    CHECK (NULLIF(btrim(audit_note), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_signoffs_idempotency_not_blank
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_signoffs_correlation_not_blank
    CHECK (NULLIF(btrim(correlation_id), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_signoffs_request_not_blank
    CHECK (NULLIF(btrim(request_id), '') IS NOT NULL)
);

-- Keep migration 108 idempotent for databases that ran an earlier development
-- draft before runtime identity became part of the executable specification.
ALTER TABLE mbt_netsuite_preflight_signoffs
  ADD COLUMN IF NOT EXISTS runtime_fingerprint text NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE mbt_netsuite_preflight_signoffs
  ALTER COLUMN runtime_fingerprint DROP DEFAULT,
  ALTER COLUMN runtime_fingerprint SET NOT NULL;
ALTER TABLE mbt_netsuite_preflight_signoffs
  DROP CONSTRAINT IF EXISTS mbt_netsuite_preflight_signoffs_runtime_sha256;
ALTER TABLE mbt_netsuite_preflight_signoffs
  ADD CONSTRAINT mbt_netsuite_preflight_signoffs_runtime_sha256
    CHECK (runtime_fingerprint ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_preflight_signoffs_signed
  ON mbt_netsuite_preflight_signoffs (signed_at DESC, signoff_id);

DROP TRIGGER IF EXISTS trg_mbt_netsuite_preflight_signoffs_immutable
  ON mbt_netsuite_preflight_signoffs;
CREATE TRIGGER trg_mbt_netsuite_preflight_signoffs_immutable
  BEFORE UPDATE OR DELETE ON mbt_netsuite_preflight_signoffs
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION mbt_validate_netsuite_preflight_signoff_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run mbt_netsuite_preflight_runs%ROWTYPE;
BEGIN
  SELECT *
    INTO parent_run
    FROM mbt_netsuite_preflight_runs
   WHERE preflight_run_id = NEW.preflight_run_id;
  IF NOT FOUND
     OR parent_run.status <> 'passed'
     OR parent_run.adapter_kind <> 'read_only_sandbox'
     OR lower(parent_run.environment_name) <> 'sandbox'
     OR parent_run.runtime_fingerprint = repeat('0', 64)
     OR parent_run.configuration_hash <> NEW.configuration_hash
     OR parent_run.runtime_fingerprint <> NEW.runtime_fingerprint THEN
    RAISE EXCEPTION 'NetSuite preflight signoff must match one passing sandbox run exactly'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_netsuite_preflight_signoffs_validate_insert
  ON mbt_netsuite_preflight_signoffs;
CREATE TRIGGER trg_mbt_netsuite_preflight_signoffs_validate_insert
  BEFORE INSERT ON mbt_netsuite_preflight_signoffs
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_netsuite_preflight_signoff_insert();

CREATE OR REPLACE FUNCTION mbt_reject_completed_preflight_check_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  run_created_in_transaction boolean;
  target_run_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NetSuite preflight checks must be retained'
      USING ERRCODE = '55000';
  END IF;
  target_run_id := NEW.preflight_run_id;
  SELECT status, xmin::text = pg_current_xact_id()::text
    INTO run_status, run_created_in_transaction
    FROM mbt_netsuite_preflight_runs
   WHERE preflight_run_id = target_run_id;
  IF run_status IN ('passed', 'failed', 'unable_to_verify', 'cancelled')
     AND NOT (TG_OP = 'INSERT' AND run_created_in_transaction) THEN
    RAISE EXCEPTION 'checks for completed NetSuite preflight run % are immutable', target_run_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_netsuite_preflight_checks_completed_immutable
  ON mbt_netsuite_preflight_checks;
CREATE TRIGGER trg_mbt_netsuite_preflight_checks_completed_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbt_netsuite_preflight_checks
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_completed_preflight_check_mutation();

COMMENT ON TABLE mbt_netsuite_preflight_signoffs IS
  'Immutable Admin signoff for one passing preflight and its exact configuration hash; it does not activate posting.';

COMMENT ON INDEX idx_mbt_netsuite_preflight_one_active IS
  'Database singleton for an active Phase 2 NetSuite sandbox preflight claim.';
