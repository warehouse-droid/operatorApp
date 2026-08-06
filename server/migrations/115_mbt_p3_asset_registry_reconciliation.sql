-- Phase 3.5 local asset registry reconciliation evidence.
-- This migration is additive and local-only. It does not enable a capability,
-- mutate an asset ledger, import a live file, or create external work.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS mbt_asset_reconciliation_batches (
  batch_id uuid PRIMARY KEY,
  schema_version text NOT NULL DEFAULT 'mbt-asset-reconciliation-v1',
  comparison_kind text NOT NULL DEFAULT 'asset_movement',
  summary jsonb NOT NULL,
  actor_operator_id text NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_asset_reconciliation_batches_schema
    CHECK (schema_version = 'mbt-asset-reconciliation-v1'),
  CONSTRAINT mbt_asset_reconciliation_batches_kind
    CHECK (comparison_kind = 'asset_movement'),
  CONSTRAINT mbt_asset_reconciliation_batches_summary_object
    CHECK (jsonb_typeof(summary) = 'object'),
  CONSTRAINT mbt_asset_reconciliation_batches_actor_not_blank
    CHECK (NULLIF(btrim(actor_operator_id), '') IS NOT NULL),
  CONSTRAINT mbt_asset_reconciliation_batches_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT mbt_asset_reconciliation_batches_key_not_blank
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS mbt_asset_reconciliation_rows (
  comparison_row_id uuid PRIMARY KEY,
  batch_id uuid NOT NULL
    REFERENCES mbt_asset_reconciliation_batches(batch_id) ON DELETE RESTRICT,
  row_number integer NOT NULL,
  manual_row_id text NOT NULL,
  asset_id uuid NOT NULL,
  movement_id uuid NOT NULL,
  asset_sequence bigint NOT NULL,
  initial_status text NOT NULL,
  application_snapshot jsonb NOT NULL,
  manual_snapshot jsonb NOT NULL,
  mismatch_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_asset_reconciliation_rows_number_positive
    CHECK (row_number > 0),
  CONSTRAINT mbt_asset_reconciliation_rows_manual_id_not_blank
    CHECK (NULLIF(btrim(manual_row_id), '') IS NOT NULL),
  CONSTRAINT mbt_asset_reconciliation_rows_sequence_positive
    CHECK (asset_sequence > 0),
  CONSTRAINT mbt_asset_reconciliation_rows_status
    CHECK (initial_status IN ('matched', 'open_variance')),
  CONSTRAINT mbt_asset_reconciliation_rows_application_object
    CHECK (jsonb_typeof(application_snapshot) = 'object'),
  CONSTRAINT mbt_asset_reconciliation_rows_manual_object
    CHECK (jsonb_typeof(manual_snapshot) = 'object'),
  CONSTRAINT mbt_asset_reconciliation_rows_batch_number_unique
    UNIQUE (batch_id, row_number),
  CONSTRAINT mbt_asset_reconciliation_rows_batch_manual_unique
    UNIQUE (batch_id, manual_row_id),
  CONSTRAINT mbt_asset_reconciliation_rows_asset_sequence_unique
    UNIQUE (batch_id, asset_id, asset_sequence),
  CONSTRAINT mbt_asset_reconciliation_rows_movement_fk
    FOREIGN KEY (asset_id, movement_id)
    REFERENCES mbt_bin_movements(asset_id, movement_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_mbt_asset_reconciliation_rows_batch
  ON mbt_asset_reconciliation_rows (batch_id, row_number, comparison_row_id);

CREATE INDEX IF NOT EXISTS idx_mbt_asset_reconciliation_rows_open
  ON mbt_asset_reconciliation_rows (asset_id, asset_sequence, comparison_row_id)
  WHERE initial_status = 'open_variance';

CREATE TABLE IF NOT EXISTS mbt_asset_reconciliation_resolutions (
  resolution_id uuid PRIMARY KEY,
  comparison_row_id uuid NOT NULL UNIQUE
    REFERENCES mbt_asset_reconciliation_rows(comparison_row_id) ON DELETE RESTRICT,
  decision text NOT NULL,
  audit_note text NOT NULL,
  actor_operator_id text NOT NULL,
  idempotency_key text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_asset_reconciliation_resolutions_decision
    CHECK (decision IN (
      'accepted_application', 'accepted_manual', 'corrected_application',
      'corrected_manual', 'evidence_only'
    )),
  CONSTRAINT mbt_asset_reconciliation_resolutions_note_not_blank
    CHECK (NULLIF(btrim(audit_note), '') IS NOT NULL),
  CONSTRAINT mbt_asset_reconciliation_resolutions_actor_not_blank
    CHECK (NULLIF(btrim(actor_operator_id), '') IS NOT NULL),
  CONSTRAINT mbt_asset_reconciliation_resolutions_key_not_blank
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL)
);

DROP TRIGGER IF EXISTS trg_mbt_asset_reconciliation_batches_immutable
  ON mbt_asset_reconciliation_batches;
CREATE TRIGGER trg_mbt_asset_reconciliation_batches_immutable
  BEFORE UPDATE OR DELETE ON mbt_asset_reconciliation_batches
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

DROP TRIGGER IF EXISTS trg_mbt_asset_reconciliation_rows_immutable
  ON mbt_asset_reconciliation_rows;
CREATE TRIGGER trg_mbt_asset_reconciliation_rows_immutable
  BEFORE UPDATE OR DELETE ON mbt_asset_reconciliation_rows
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

DROP TRIGGER IF EXISTS trg_mbt_asset_reconciliation_resolutions_immutable
  ON mbt_asset_reconciliation_resolutions;
CREATE TRIGGER trg_mbt_asset_reconciliation_resolutions_immutable
  BEFORE UPDATE OR DELETE ON mbt_asset_reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

COMMENT ON TABLE mbt_asset_reconciliation_batches IS
  'Local-only immutable P3.5 asset movement comparison batch evidence.';

COMMENT ON TABLE mbt_asset_reconciliation_rows IS
  'Immutable application/manual movement snapshots and their initial comparison result.';

COMMENT ON TABLE mbt_asset_reconciliation_resolutions IS
  'Append-only audited terminal decisions for an asset movement variance.';
