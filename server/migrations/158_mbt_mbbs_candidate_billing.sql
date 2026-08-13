BEGIN;

-- A billing candidate snapshot is frozen by the server immediately before a
-- durable local-only billing conversion. It is distinct from the historical
-- Dispatch snapshot path and remains protected by the existing immutable-row
-- trigger and source-identity uniqueness constraint.
ALTER TABLE mbt_mbbs_completed_load_snapshots
  DROP CONSTRAINT IF EXISTS mbt_mbbs_completed_load_source_system;
ALTER TABLE mbt_mbbs_completed_load_snapshots
  ADD CONSTRAINT mbt_mbbs_completed_load_source_system
    CHECK (source_system IN ('dispatch', 'migration', 'billing_candidate'));

-- Dispatcher/Front Desk custom local delivery orders are valid MBBS transport
-- work and need a durable cross-charge identity of their own.
ALTER TABLE mbt_cross_charge_cases
  DROP CONSTRAINT IF EXISTS mbt_cross_charge_cases_source_type;
ALTER TABLE mbt_cross_charge_cases
  ADD CONSTRAINT mbt_cross_charge_cases_source_type
    CHECK (source_type IN ('SO', 'TO', 'PO', 'VRMA', 'CUSTOM'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_cross_charge_cases_custom_load
  ON mbt_cross_charge_cases (root_reference, physical_load_id)
  WHERE source_type = 'CUSTOM';

COMMIT;
