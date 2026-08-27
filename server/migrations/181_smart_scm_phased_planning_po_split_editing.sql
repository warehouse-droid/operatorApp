-- Smart SCM location skipping, explicit PO-then-transfer planning, and
-- auditable desired-state edits for local PO split children.

ALTER TABLE scm_smart_settings
  ADD COLUMN IF NOT EXISTS skip_12441_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_planning_mode text NOT NULL DEFAULT 'integrated';

ALTER TABLE scm_smart_settings
  DROP CONSTRAINT IF EXISTS scm_smart_settings_inventory_planning_mode_check;

ALTER TABLE scm_smart_settings
  ADD CONSTRAINT scm_smart_settings_inventory_planning_mode_check
  CHECK (inventory_planning_mode IN ('integrated', 'po_then_transfer'));

COMMENT ON COLUMN scm_smart_settings.skip_12441_enabled IS
  'When enabled, automatic Smart SCM demand and destinations skip 12441 and redistribute its demand to 3445/2967.';
COMMENT ON COLUMN scm_smart_settings.inventory_planning_mode IS
  'integrated preserves the legacy one-pass plan; po_then_transfer freezes PO phase one before an explicit transfer-phase approval.';

ALTER TABLE scm_smart_planning_runs
  ADD COLUMN IF NOT EXISTS planning_phase text NOT NULL DEFAULT 'integrated',
  ADD COLUMN IF NOT EXISTS phase_one_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS phase_one_approved_by text,
  ADD COLUMN IF NOT EXISTS phase_two_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS phase_two_created_at timestamptz;

ALTER TABLE scm_smart_planning_runs
  DROP CONSTRAINT IF EXISTS scm_smart_planning_runs_phase_check;

ALTER TABLE scm_smart_planning_runs
  ADD CONSTRAINT scm_smart_planning_runs_phase_check
  CHECK (planning_phase IN ('integrated', 'po_pending_approval', 'transfer_ready'));

ALTER TABLE dispatch_scm_po_splits
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS dispatch_scm_po_split_change_events (
  id bigserial PRIMARY KEY,
  split_id bigint NOT NULL REFERENCES dispatch_scm_po_splits(id) ON DELETE RESTRICT,
  expected_revision bigint,
  applied_revision bigint NOT NULL,
  event_type text NOT NULL,
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_scm_po_split_change_event_type_check
    CHECK (event_type IN ('lines_adjusted', 'ref_changed', 'destination_changed', 'pickup_changed', 'cancelled')),
  CONSTRAINT dispatch_scm_po_split_change_event_revision_check
    CHECK (applied_revision > 0 AND (expected_revision IS NULL OR expected_revision >= 0))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_po_split_change_events_split
  ON dispatch_scm_po_split_change_events (split_id, applied_revision, id);

CREATE OR REPLACE FUNCTION dispatch_scm_po_split_change_events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_dispatch_scm_po_split_change_events_immutable
  ON dispatch_scm_po_split_change_events;

CREATE TRIGGER trg_dispatch_scm_po_split_change_events_immutable
BEFORE UPDATE OR DELETE ON dispatch_scm_po_split_change_events
FOR EACH ROW EXECUTE FUNCTION dispatch_scm_po_split_change_events_reject_mutation();

ALTER TABLE scm_smart_blanket_release_events
  DROP CONSTRAINT IF EXISTS scm_smart_blanket_release_events_type_check;

ALTER TABLE scm_smart_blanket_release_events
  ADD CONSTRAINT scm_smart_blanket_release_events_type_check CHECK (
    event_type IN (
      'reserved', 'reservation_cancelled', 'vendor_finalized', 'split_created',
      'held', 'cancelled', 'alternative_added', 'alternative_removed',
      'vendor_destination_updated', 'split_adjusted'
    )
  );
