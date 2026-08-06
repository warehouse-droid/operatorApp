-- MBT Phase 3.10 immutable pilot reconciliation and local-only shadow billing.
--
-- This migration is additive and inert while mbt_billing_operations remains
-- disabled. It introduces no worker, scheduler, notification, posting state,
-- NetSuite credential, transport, Sales Order chain, deposit, or outbox work.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS mbt_pilot_reconciliation_batches (
  reconciliation_batch_id uuid PRIMARY KEY,
  batch_reference text NOT NULL UNIQUE,
  manual_source text NOT NULL,
  created_by text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_pilot_reconciliation_batches_reference_not_blank
    CHECK (NULLIF(btrim(batch_reference), '') IS NOT NULL),
  CONSTRAINT mbt_pilot_reconciliation_batches_source_not_blank
    CHECK (NULLIF(btrim(manual_source), '') IS NOT NULL),
  CONSTRAINT mbt_pilot_reconciliation_batches_actor_not_blank
    CHECK (NULLIF(btrim(created_by), '') IS NOT NULL),
  CONSTRAINT mbt_pilot_reconciliation_batches_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS mbt_pilot_reconciliation_rows (
  reconciliation_row_id uuid PRIMARY KEY,
  reconciliation_batch_id uuid NOT NULL
    REFERENCES mbt_pilot_reconciliation_batches(reconciliation_batch_id)
    ON DELETE RESTRICT,
  comparison_kind text NOT NULL,
  application_evidence_id uuid NOT NULL,
  manual_reference text NOT NULL,
  application_snapshot jsonb NOT NULL,
  manual_snapshot jsonb NOT NULL,
  application_snapshot_hash text NOT NULL,
  manual_snapshot_hash text NOT NULL,
  comparison_result text NOT NULL,
  differences jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking boolean NOT NULL,
  requires_audit_note boolean NOT NULL DEFAULT false,
  distance_delta_metres bigint,
  distance_audit_threshold_metres bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_pilot_reconciliation_rows_kind
    CHECK (
      comparison_kind IN (
        'movement', 'receipt', 'distance', 'billing_line',
        'cross_charge_allocation'
      )
    ),
  CONSTRAINT mbt_pilot_reconciliation_rows_manual_reference_not_blank
    CHECK (NULLIF(btrim(manual_reference), '') IS NOT NULL),
  CONSTRAINT mbt_pilot_reconciliation_rows_snapshots_object
    CHECK (
      jsonb_typeof(application_snapshot) = 'object'
      AND jsonb_typeof(manual_snapshot) = 'object'
    ),
  CONSTRAINT mbt_pilot_reconciliation_rows_hashes
    CHECK (
      application_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND manual_snapshot_hash ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT mbt_pilot_reconciliation_rows_result
    CHECK (comparison_result IN ('matched', 'open_variance')),
  CONSTRAINT mbt_pilot_reconciliation_rows_differences_array
    CHECK (jsonb_typeof(differences) = 'array'),
  CONSTRAINT mbt_pilot_reconciliation_rows_result_shape
    CHECK (
      (comparison_result = 'matched' AND NOT blocking AND differences = '[]'::jsonb)
      OR
      (comparison_result = 'open_variance' AND jsonb_array_length(differences) > 0)
    ),
  CONSTRAINT mbt_pilot_reconciliation_rows_distance_shape
    CHECK (
      (
        comparison_kind = 'distance'
        AND distance_delta_metres IS NOT NULL
        AND distance_delta_metres >= 0
        AND distance_audit_threshold_metres IS NOT NULL
        AND distance_audit_threshold_metres >= 2000
      )
      OR
      (
        comparison_kind <> 'distance'
        AND distance_delta_metres IS NULL
        AND distance_audit_threshold_metres IS NULL
        AND NOT requires_audit_note
      )
    ),
  CONSTRAINT mbt_pilot_reconciliation_rows_batch_identity_unique
    UNIQUE (
      reconciliation_batch_id,
      comparison_kind,
      application_evidence_id,
      manual_reference
    )
);

CREATE INDEX IF NOT EXISTS idx_mbt_pilot_reconciliation_rows_open
  ON mbt_pilot_reconciliation_rows (
    blocking,
    comparison_kind,
    application_evidence_id,
    reconciliation_row_id
  )
  WHERE comparison_result = 'open_variance';

CREATE TABLE IF NOT EXISTS mbt_pilot_reconciliation_resolutions (
  reconciliation_resolution_id uuid PRIMARY KEY,
  reconciliation_row_id uuid NOT NULL UNIQUE
    REFERENCES mbt_pilot_reconciliation_rows(reconciliation_row_id)
    ON DELETE RESTRICT,
  decision text NOT NULL,
  note text NOT NULL,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  application_snapshot_hash text NOT NULL,
  manual_snapshot_hash text NOT NULL,
  correction_reference jsonb,
  CONSTRAINT mbt_pilot_reconciliation_resolutions_decision
    CHECK (
      decision IN (
        'accepted_application', 'accepted_manual', 'corrected_application',
        'corrected_manual', 'evidence_only'
      )
    ),
  CONSTRAINT mbt_pilot_reconciliation_resolutions_note_not_blank
    CHECK (NULLIF(btrim(note), '') IS NOT NULL),
  CONSTRAINT mbt_pilot_reconciliation_resolutions_actor_not_blank
    CHECK (NULLIF(btrim(decided_by), '') IS NOT NULL),
  CONSTRAINT mbt_pilot_reconciliation_resolutions_hashes
    CHECK (
      application_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND manual_snapshot_hash ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT mbt_pilot_reconciliation_resolutions_correction_object
    CHECK (
      correction_reference IS NULL
      OR jsonb_typeof(correction_reference) = 'object'
    ),
  CONSTRAINT mbt_pilot_reconciliation_resolutions_correction_required
    CHECK (
      decision NOT IN ('corrected_application', 'corrected_manual')
      OR correction_reference IS NOT NULL
    )
);

DROP TRIGGER IF EXISTS trg_mbt_pilot_reconciliation_batches_immutable
  ON mbt_pilot_reconciliation_batches;
CREATE TRIGGER trg_mbt_pilot_reconciliation_batches_immutable
  BEFORE UPDATE OR DELETE ON mbt_pilot_reconciliation_batches
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

DROP TRIGGER IF EXISTS trg_mbt_pilot_reconciliation_rows_immutable
  ON mbt_pilot_reconciliation_rows;
CREATE TRIGGER trg_mbt_pilot_reconciliation_rows_immutable
  BEFORE UPDATE OR DELETE ON mbt_pilot_reconciliation_rows
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

DROP TRIGGER IF EXISTS trg_mbt_pilot_reconciliation_resolutions_immutable
  ON mbt_pilot_reconciliation_resolutions;
CREATE TRIGGER trg_mbt_pilot_reconciliation_resolutions_immutable
  BEFORE UPDATE OR DELETE ON mbt_pilot_reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

ALTER TABLE mbt_cross_charge_cases
  ADD COLUMN IF NOT EXISTS deduplication_key text;

UPDATE mbt_cross_charge_cases
   SET deduplication_key = CASE
     WHEN source_type = 'TO' THEN source_type || '|' || root_reference
     ELSE source_type || '|' || root_reference || '|' || physical_load_id
   END
 WHERE deduplication_key IS NULL;

ALTER TABLE mbt_cross_charge_cases
  ALTER COLUMN deduplication_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_cross_charge_cases_deduplication
  ON mbt_cross_charge_cases (deduplication_key);

ALTER TABLE mbt_billing_versions
  ADD COLUMN IF NOT EXISTS calculated_by text,
  ADD COLUMN IF NOT EXISTS calculation_reason text,
  ADD COLUMN IF NOT EXISTS calculated_at timestamptz;

ALTER TABLE mbt_billing_versions
  ALTER COLUMN approved_by DROP NOT NULL,
  ALTER COLUMN approval_reason DROP NOT NULL,
  ALTER COLUMN approved_at DROP NOT NULL;

ALTER TABLE mbt_billing_versions
  DROP CONSTRAINT IF EXISTS mbt_billing_versions_amounts_nonnegative;
ALTER TABLE mbt_billing_versions
  ADD CONSTRAINT mbt_billing_versions_amounts_nonnegative
    CHECK (subtotal_minor >= 0 AND total_minor >= 0) NOT VALID;

ALTER TABLE mbt_billing_versions
  DROP CONSTRAINT IF EXISTS mbt_billing_versions_approver_not_blank,
  DROP CONSTRAINT IF EXISTS mbt_billing_versions_reason_not_blank,
  DROP CONSTRAINT IF EXISTS mbt_billing_versions_approval_complete;
ALTER TABLE mbt_billing_versions
  ADD CONSTRAINT mbt_billing_versions_approval_complete
    CHECK (
      status <> 'approved'
      OR (
        NULLIF(btrim(COALESCE(approved_by, '')), '') IS NOT NULL
        AND NULLIF(btrim(COALESCE(approval_reason, '')), '') IS NOT NULL
        AND approved_at IS NOT NULL
      )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION mbt_guard_billing_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'draft'
     AND NEW.status = 'approved'
     AND NULLIF(btrim(COALESCE(NEW.approved_by, '')), '') IS NOT NULL
     AND NULLIF(btrim(COALESCE(NEW.approval_reason, '')), '') IS NOT NULL
     AND NEW.approved_at IS NOT NULL
     AND (
       to_jsonb(NEW) - ARRAY['status', 'approved_by', 'approval_reason', 'approved_at']
     ) = (
       to_jsonb(OLD) - ARRAY['status', 'approved_by', 'approval_reason', 'approved_at']
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is immutable; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

ALTER TABLE mbt_billing_lines
  ADD COLUMN IF NOT EXISTS line_key text,
  ADD COLUMN IF NOT EXISTS deduplication_key text,
  ADD COLUMN IF NOT EXISTS customer_charge_minor bigint,
  ADD COLUMN IF NOT EXISTS actual_cost_minor bigint,
  ADD COLUMN IF NOT EXISTS margin_minor bigint;

UPDATE mbt_billing_lines
   SET line_key = 'legacy:' || sequence_number::text
 WHERE line_key IS NULL;

ALTER TABLE mbt_billing_lines
  ALTER COLUMN line_key SET NOT NULL,
  DROP CONSTRAINT IF EXISTS mbt_billing_lines_type,
  DROP CONSTRAINT IF EXISTS mbt_billing_lines_amounts_nonnegative;

ALTER TABLE mbt_billing_lines
  ADD CONSTRAINT mbt_billing_lines_type
    CHECK (
      line_type IN (
        'transport', 'rental', 'extension', 'exchange', 'pickup', 'dump',
        'downtown_surcharge', 'surcharge', 'discount', 'custom_price',
        'cross_charge', 'other'
      )
    ),
  ADD CONSTRAINT mbt_billing_lines_amount_shape
    CHECK (
      (
        line_type = 'discount'
        AND unit_amount_minor <= 0
        AND net_amount_minor <= 0
        AND estimated_tax_minor <= 0
        AND total_amount_minor <= 0
      )
      OR
      (
        line_type <> 'discount'
        AND unit_amount_minor >= 0
        AND net_amount_minor >= 0
        AND estimated_tax_minor >= 0
        AND total_amount_minor >= 0
      )
    ),
  ADD CONSTRAINT mbt_billing_lines_dump_economics_shape
    CHECK (
      (
        customer_charge_minor IS NULL
        AND actual_cost_minor IS NULL
        AND margin_minor IS NULL
      )
      OR
      (
        line_type = 'dump'
        AND customer_charge_minor IS NOT NULL
        AND customer_charge_minor = net_amount_minor
        AND actual_cost_minor IS NOT NULL
        AND actual_cost_minor >= 0
        AND margin_minor IS NOT NULL
        AND margin_minor = customer_charge_minor - actual_cost_minor
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_billing_lines_version_line_key
  ON mbt_billing_lines (billing_version_id, line_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_billing_lines_version_dedupe
  ON mbt_billing_lines (billing_version_id, deduplication_key)
  WHERE deduplication_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS mbt_billing_version_amendments (
  billing_version_amendment_id uuid PRIMARY KEY,
  billing_case_id uuid NOT NULL
    REFERENCES mbt_billing_cases(billing_case_id) ON DELETE RESTRICT,
  original_billing_version_id uuid NOT NULL
    REFERENCES mbt_billing_versions(billing_version_id) ON DELETE RESTRICT,
  amended_billing_version_id uuid NOT NULL UNIQUE
    REFERENCES mbt_billing_versions(billing_version_id) ON DELETE RESTRICT,
  amendment_kind text NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_billing_version_amendments_distinct
    CHECK (original_billing_version_id <> amended_billing_version_id),
  CONSTRAINT mbt_billing_version_amendments_kind
    CHECK (amendment_kind IN ('correction', 'amendment', 'reversal', 'recalculation')),
  CONSTRAINT mbt_billing_version_amendments_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT mbt_billing_version_amendments_actor_not_blank
    CHECK (NULLIF(btrim(created_by), '') IS NOT NULL),
  CONSTRAINT mbt_billing_version_amendments_evidence_object
    CHECK (jsonb_typeof(evidence_snapshot) = 'object')
);

CREATE OR REPLACE FUNCTION mbt_guard_billing_version_amendment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original_case_id uuid;
  original_status text;
  original_version_number integer;
  amended_case_id uuid;
  amended_status text;
  amended_version_number integer;
BEGIN
  SELECT billing_case_id, status, version_number
    INTO original_case_id, original_status, original_version_number
    FROM mbt_billing_versions
   WHERE billing_version_id = NEW.original_billing_version_id;
  SELECT billing_case_id, status, version_number
    INTO amended_case_id, amended_status, amended_version_number
    FROM mbt_billing_versions
   WHERE billing_version_id = NEW.amended_billing_version_id;
  IF original_case_id IS DISTINCT FROM NEW.billing_case_id
     OR amended_case_id IS DISTINCT FROM NEW.billing_case_id
     OR original_status <> 'approved'
     OR amended_status <> 'draft'
     OR amended_version_number <= original_version_number THEN
    RAISE EXCEPTION 'Billing amendment lineage is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_billing_version_amendment_lineage';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_billing_version_amendments_guard
  ON mbt_billing_version_amendments;
CREATE TRIGGER trg_mbt_billing_version_amendments_guard
  BEFORE INSERT ON mbt_billing_version_amendments
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_billing_version_amendment();

DROP TRIGGER IF EXISTS trg_mbt_billing_version_amendments_immutable
  ON mbt_billing_version_amendments;
CREATE TRIGGER trg_mbt_billing_version_amendments_immutable
  BEFORE UPDATE OR DELETE ON mbt_billing_version_amendments
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION mbt_reject_local_only_outbox_work()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.billing_version_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM mbt_billing_versions version
        WHERE version.billing_version_id = NEW.billing_version_id
          AND version.posting_mode = 'local_only'
     ) THEN
    RAISE EXCEPTION 'A local-only billing version cannot create outbox work'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_local_only_outbox_work';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_local_only_outbox_work
  ON mbt_netsuite_outbox;
CREATE TRIGGER trg_mbt_local_only_outbox_work
  BEFORE INSERT OR UPDATE ON mbt_netsuite_outbox
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_local_only_outbox_work();

COMMENT ON TABLE mbt_pilot_reconciliation_batches IS
  'Immutable P3.10 manual comparison batch identity and source evidence.';
COMMENT ON TABLE mbt_pilot_reconciliation_rows IS
  'Independent immutable application/manual snapshots and deterministic comparison result.';
COMMENT ON TABLE mbt_pilot_reconciliation_resolutions IS
  'Append-only audited terminal variance decisions; originals are never rewritten.';
COMMENT ON TABLE mbt_billing_version_amendments IS
  'Immutable original-to-new billing-version lineage for local correction and amendment.';
