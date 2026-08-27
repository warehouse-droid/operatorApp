-- Append-only effective-item corrections for Sales Order re-attempts.
-- Historical Operator, Driver, and Dispatch evidence is intentionally retained.

ALTER TABLE operator_reload_cycles
  ADD COLUMN IF NOT EXISTS completion_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS operator_load_evidence_missing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS completion_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS completion_reconciled_by text,
  ADD COLUMN IF NOT EXISTS completion_reconciliation_note text NOT NULL DEFAULT '';

ALTER TABLE operator_reload_cycles
  DROP CONSTRAINT IF EXISTS operator_reload_cycles_completion_source_valid;
ALTER TABLE operator_reload_cycles
  ADD CONSTRAINT operator_reload_cycles_completion_source_valid
  CHECK (completion_source IN ('', 'operator_load', 'driver_completion_reconciliation'));

UPDATE operator_reload_cycles cycle
   SET completion_source = 'operator_load',
       operator_load_evidence_missing = false
 WHERE cycle.status = 'completed'
   AND cycle.completion_source = ''
   AND EXISTS (
     SELECT 1
       FROM operator_load_records record
      WHERE record.reload_cycle_id = cycle.id
   );

CREATE TABLE IF NOT EXISTS sales_order_reattempt_item_corrections (
  id bigserial PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  reattempt_order_id bigint NOT NULL REFERENCES dispatch_custom_orders(id) ON DELETE RESTRICT,
  cycle_id bigint NOT NULL REFERENCES operator_reload_cycles(id) ON DELETE RESTRICT,
  parent_sales_order_id bigint NOT NULL REFERENCES sales_orders(netsuite_id) ON DELETE RESTRICT,
  netsuite_line_id bigint NOT NULL,
  before_item_id bigint,
  before_sku text NOT NULL DEFAULT '',
  before_item_name text NOT NULL DEFAULT '',
  before_description text NOT NULL DEFAULT '',
  before_sales_uom text NOT NULL DEFAULT '',
  after_item_id bigint NOT NULL,
  after_sku text NOT NULL,
  after_item_name text NOT NULL,
  after_description text NOT NULL DEFAULT '',
  after_sales_uom text NOT NULL DEFAULT '',
  target_sales_qty numeric NOT NULL CHECK (target_sales_qty >= 0),
  target_pallet_qty numeric NOT NULL DEFAULT 0 CHECK (target_pallet_qty >= 0),
  target_layer_qty numeric NOT NULL DEFAULT 0 CHECK (target_layer_qty >= 0),
  target_section_qty numeric NOT NULL DEFAULT 0 CHECK (target_section_qty >= 0),
  target_piece_qty numeric NOT NULL DEFAULT 0 CHECK (target_piece_qty >= 0),
  expected_child_status text NOT NULL,
  expected_cycle_status text NOT NULL,
  expected_state_fingerprint text NOT NULL,
  physically_delivered_current_item boolean NOT NULL,
  reason text NOT NULL,
  actor_operator_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  supersedes_correction_id bigint REFERENCES sales_order_reattempt_item_corrections(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_reattempt_item_corrections_ref_valid
    CHECK (netsuite_line_id > 0),
  CONSTRAINT sales_order_reattempt_item_corrections_after_valid
    CHECK (after_item_id > 0 AND NULLIF(btrim(after_sku), '') IS NOT NULL),
  CONSTRAINT sales_order_reattempt_item_corrections_reason_valid
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT sales_order_reattempt_item_corrections_fingerprint_valid
    CHECK (expected_state_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT sales_order_reattempt_item_corrections_physical_confirmation
    CHECK (physically_delivered_current_item = true)
);

CREATE INDEX IF NOT EXISTS idx_sales_order_reattempt_item_corrections_effective
  ON sales_order_reattempt_item_corrections (
    reattempt_order_id,
    netsuite_line_id,
    created_at DESC,
    id DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_order_reattempt_item_corrections_successor
  ON sales_order_reattempt_item_corrections (supersedes_correction_id)
  WHERE supersedes_correction_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_sales_order_reattempt_item_corrections_immutable
  ON sales_order_reattempt_item_corrections;
CREATE TRIGGER trg_sales_order_reattempt_item_corrections_immutable
  BEFORE UPDATE OR DELETE ON sales_order_reattempt_item_corrections
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

COMMENT ON TABLE sales_order_reattempt_item_corrections IS
  'Append-only current projection overlay for a Sales Order re-attempt item; raw operational evidence remains immutable.';
COMMENT ON COLUMN operator_reload_cycles.completion_source IS
  'operator_load for normal completion, or driver_completion_reconciliation for an audited legacy sequence anomaly.';
COMMENT ON COLUMN operator_reload_cycles.operator_load_evidence_missing IS
  'True only when a completed historical Driver re-attempt is reconciled without fabricating missing Operator load evidence.';
