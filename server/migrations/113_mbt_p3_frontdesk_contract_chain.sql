-- MBT Phase 3 Front Desk containment and visit-chain invariants.
--
-- This migration is deliberately additive. It does not connect Front Desk
-- records to DispatchV2, Driver, Operator, NetSuite posting, or any scheduler.

ALTER TABLE mbt_service_visits
  ADD COLUMN IF NOT EXISTS predecessor_visit_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'mbt_service_visits_predecessor_fk'
       AND conrelid = 'mbt_service_visits'::regclass
  ) THEN
    ALTER TABLE mbt_service_visits
      ADD CONSTRAINT mbt_service_visits_predecessor_fk
      FOREIGN KEY (predecessor_visit_id)
      REFERENCES mbt_service_visits(service_visit_id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'mbt_service_visits_predecessor_not_self'
       AND conrelid = 'mbt_service_visits'::regclass
  ) THEN
    ALTER TABLE mbt_service_visits
      ADD CONSTRAINT mbt_service_visits_predecessor_not_self
      CHECK (
        predecessor_visit_id IS NULL
        OR predecessor_visit_id <> service_visit_id
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_service_visits_one_successor
  ON mbt_service_visits (predecessor_visit_id)
  WHERE predecessor_visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mbt_service_visits_predecessor
  ON mbt_service_visits (contract_id, predecessor_visit_id, visit_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_contracts_quote_conversion
  ON mbt_contracts (quote_id)
  WHERE quote_id IS NOT NULL;
