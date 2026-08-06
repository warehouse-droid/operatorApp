-- MBT Phase 1 NetSuite configuration catalog and read-only metadata preflight
-- foundations. This migration stores mapping revisions and validation evidence;
-- it creates no credentials, scheduler, or NetSuite write path.

CREATE TABLE IF NOT EXISTS mbt_netsuite_mappings (
  mapping_id uuid PRIMARY KEY,
  mapping_type text NOT NULL,
  local_key text NOT NULL,
  external_id text NOT NULL,
  external_script_id text,
  external_name text NOT NULL DEFAULT '',
  external_record_type text NOT NULL,
  subsidiary_netsuite_id bigint,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT true,
  validation_status text NOT NULL DEFAULT 'unverified',
  validation_message text NOT NULL DEFAULT '',
  last_verified_at timestamptz,
  last_verified_by text,
  revision bigint NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_netsuite_mappings_type
    CHECK (
      mapping_type IN (
        'subsidiary', 'intercompany_customer', 'sales_order_form',
        'customer_deposit_form', 'sales_order_item', 'tax_code',
        'income_account', 'liability_account', 'payment_account',
        'payment_method', 'custom_field', 'file_cabinet_folder',
        'transaction_identifier', 'integration_permission'
      )
    ),
  CONSTRAINT mbt_netsuite_mappings_local_key_format
    CHECK (local_key ~ '^[a-z][a-z0-9_.:-]*$'),
  CONSTRAINT mbt_netsuite_mappings_external_id_not_blank
    CHECK (NULLIF(btrim(external_id), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_mappings_script_id_not_blank
    CHECK (external_script_id IS NULL OR NULLIF(btrim(external_script_id), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_mappings_record_type_not_blank
    CHECK (NULLIF(btrim(external_record_type), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_mappings_subsidiary_positive
    CHECK (subsidiary_netsuite_id IS NULL OR subsidiary_netsuite_id > 0),
  CONSTRAINT mbt_netsuite_mappings_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT mbt_netsuite_mappings_active_current
    CHECK (NOT active OR is_current),
  CONSTRAINT mbt_netsuite_mappings_validation_status
    CHECK (validation_status IN ('unverified', 'valid', 'invalid', 'inactive', 'unable_to_verify')),
  CONSTRAINT mbt_netsuite_mappings_verified_complete
    CHECK (
      (last_verified_at IS NULL AND last_verified_by IS NULL)
      OR
      (
        last_verified_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(last_verified_by, '')), '') IS NOT NULL
      )
    ),
  CONSTRAINT mbt_netsuite_mappings_valid_is_verified
    CHECK (validation_status <> 'valid' OR last_verified_at IS NOT NULL),
  CONSTRAINT mbt_netsuite_mappings_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_netsuite_mappings_key_revision_unique
    UNIQUE (mapping_type, local_key, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_netsuite_mappings_one_current
  ON mbt_netsuite_mappings (mapping_type, local_key)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_mappings_readiness
  ON mbt_netsuite_mappings (
    active,
    validation_status,
    mapping_type,
    local_key,
    revision
  )
  WHERE is_current;

CREATE TABLE IF NOT EXISTS mbt_netsuite_preflight_runs (
  preflight_run_id uuid PRIMARY KEY,
  configuration_hash text NOT NULL,
  mapping_snapshot jsonb NOT NULL,
  adapter_kind text NOT NULL DEFAULT 'phase1_read_only_fake',
  account_id text NOT NULL,
  environment_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  required_check_count integer NOT NULL DEFAULT 0,
  passed_required_count integer NOT NULL DEFAULT 0,
  failed_required_count integer NOT NULL DEFAULT 0,
  optional_check_count integer NOT NULL DEFAULT 0,
  passed_optional_count integer NOT NULL DEFAULT 0,
  requested_by text NOT NULL,
  correlation_id text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_netsuite_preflight_runs_hash_sha256
    CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_netsuite_preflight_runs_snapshot_object
    CHECK (jsonb_typeof(mapping_snapshot) = 'array'),
  CONSTRAINT mbt_netsuite_preflight_runs_adapter
    CHECK (adapter_kind IN ('phase1_read_only_fake', 'read_only_sandbox', 'read_only_production')),
  CONSTRAINT mbt_netsuite_preflight_runs_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_runs_environment_not_blank
    CHECK (NULLIF(btrim(environment_name), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_runs_status
    CHECK (status IN ('pending', 'running', 'passed', 'failed', 'unable_to_verify', 'cancelled')),
  CONSTRAINT mbt_netsuite_preflight_runs_counts_nonnegative
    CHECK (
      required_check_count >= 0
      AND passed_required_count >= 0
      AND failed_required_count >= 0
      AND optional_check_count >= 0
      AND passed_optional_count >= 0
    ),
  CONSTRAINT mbt_netsuite_preflight_runs_required_counts_consistent
    CHECK (passed_required_count + failed_required_count <= required_check_count),
  CONSTRAINT mbt_netsuite_preflight_runs_optional_counts_consistent
    CHECK (passed_optional_count <= optional_check_count),
  CONSTRAINT mbt_netsuite_preflight_runs_requester_not_blank
    CHECK (NULLIF(btrim(requested_by), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_runs_correlation_not_blank
    CHECK (NULLIF(btrim(correlation_id), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_preflight_runs_time_order
    CHECK (started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT mbt_netsuite_preflight_runs_terminal_complete
    CHECK (
      status NOT IN ('passed', 'failed', 'unable_to_verify', 'cancelled')
      OR completed_at IS NOT NULL
    ),
  CONSTRAINT mbt_netsuite_preflight_runs_pass_complete
    CHECK (
      status <> 'passed'
      OR
      (
        failed_required_count = 0
        AND passed_required_count = required_check_count
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_preflight_runs_current_hash
  ON mbt_netsuite_preflight_runs (configuration_hash, status, completed_at DESC, preflight_run_id);

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_preflight_runs_queue
  ON mbt_netsuite_preflight_runs (status, created_at, preflight_run_id)
  WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS mbt_netsuite_preflight_checks (
  preflight_check_id uuid PRIMARY KEY,
  preflight_run_id uuid NOT NULL REFERENCES mbt_netsuite_preflight_runs(preflight_run_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL,
  check_type text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  mapping_type text,
  local_key text,
  external_record_type text,
  external_id text,
  expected_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_snapshot jsonb,
  status text NOT NULL,
  message text NOT NULL DEFAULT '',
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_netsuite_preflight_checks_sequence_nonnegative
    CHECK (sequence_number >= 0),
  CONSTRAINT mbt_netsuite_preflight_checks_type_format
    CHECK (check_type ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT mbt_netsuite_preflight_checks_mapping_pair
    CHECK ((mapping_type IS NULL) = (local_key IS NULL)),
  CONSTRAINT mbt_netsuite_preflight_checks_mapping_type
    CHECK (
      mapping_type IS NULL
      OR mapping_type IN (
        'subsidiary', 'intercompany_customer', 'sales_order_form',
        'customer_deposit_form', 'sales_order_item', 'tax_code',
        'income_account', 'liability_account', 'payment_account',
        'payment_method', 'custom_field', 'file_cabinet_folder',
        'transaction_identifier', 'integration_permission'
      )
    ),
  CONSTRAINT mbt_netsuite_preflight_checks_local_key_format
    CHECK (local_key IS NULL OR local_key ~ '^[a-z][a-z0-9_.:-]*$'),
  CONSTRAINT mbt_netsuite_preflight_checks_expected_object
    CHECK (jsonb_typeof(expected_snapshot) = 'object'),
  CONSTRAINT mbt_netsuite_preflight_checks_observed_object
    CHECK (observed_snapshot IS NULL OR jsonb_typeof(observed_snapshot) = 'object'),
  CONSTRAINT mbt_netsuite_preflight_checks_status
    CHECK (
      status IN (
        'passed', 'missing', 'invalid', 'inactive', 'wrong_subsidiary',
        'permission_denied', 'unable_to_verify', 'not_applicable'
      )
    ),
  CONSTRAINT mbt_netsuite_preflight_checks_required_not_na
    CHECK (NOT required OR status <> 'not_applicable'),
  CONSTRAINT mbt_netsuite_preflight_checks_run_sequence_unique
    UNIQUE (preflight_run_id, sequence_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_netsuite_preflight_checks_identity
  ON mbt_netsuite_preflight_checks (
    preflight_run_id,
    check_type,
    COALESCE(mapping_type, ''),
    COALESCE(local_key, '')
  );

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_preflight_checks_failure
  ON mbt_netsuite_preflight_checks (preflight_run_id, required, status, sequence_number)
  WHERE status <> 'passed';

CREATE OR REPLACE FUNCTION mbt_retain_netsuite_mapping_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NetSuite mapping revisions must be retained'
      USING ERRCODE = '55000';
  END IF;
  IF NOT OLD.is_current THEN
    RAISE EXCEPTION 'historical NetSuite mapping revision % is immutable', OLD.mapping_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_netsuite_mappings_retain_history
  ON mbt_netsuite_mappings;
CREATE TRIGGER trg_mbt_netsuite_mappings_retain_history
  BEFORE UPDATE OR DELETE ON mbt_netsuite_mappings
  FOR EACH ROW EXECUTE FUNCTION mbt_retain_netsuite_mapping_history();

CREATE OR REPLACE FUNCTION mbt_reject_completed_preflight_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NetSuite preflight runs must be retained'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('passed', 'failed', 'unable_to_verify', 'cancelled') THEN
    RAISE EXCEPTION 'completed NetSuite preflight run % is immutable', OLD.preflight_run_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_netsuite_preflight_runs_completed_immutable
  ON mbt_netsuite_preflight_runs;
CREATE TRIGGER trg_mbt_netsuite_preflight_runs_completed_immutable
  BEFORE UPDATE OR DELETE ON mbt_netsuite_preflight_runs
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_completed_preflight_mutation();

CREATE OR REPLACE FUNCTION mbt_reject_completed_preflight_check_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NetSuite preflight checks must be retained'
      USING ERRCODE = '55000';
  END IF;
  SELECT status
    INTO run_status
    FROM mbt_netsuite_preflight_runs
   WHERE preflight_run_id = OLD.preflight_run_id;
  IF run_status IN ('passed', 'failed', 'unable_to_verify', 'cancelled') THEN
    RAISE EXCEPTION 'checks for completed NetSuite preflight run % are immutable', OLD.preflight_run_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_netsuite_preflight_checks_completed_immutable
  ON mbt_netsuite_preflight_checks;
CREATE TRIGGER trg_mbt_netsuite_preflight_checks_completed_immutable
  BEFORE UPDATE OR DELETE ON mbt_netsuite_preflight_checks
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_completed_preflight_check_mutation();

COMMENT ON TABLE mbt_netsuite_mappings IS
  'Revisioned local-to-NetSuite metadata catalog; only one current revision may exist for each mapping key.';

COMMENT ON TABLE mbt_netsuite_preflight_runs IS
  'Read-only metadata preflight evidence bound to the canonical hash of the exact mapping configuration tested.';

COMMENT ON COLUMN mbt_netsuite_preflight_runs.configuration_hash IS
  'A passing run is reusable only while this SHA-256 equals the current canonical mapping configuration hash.';
