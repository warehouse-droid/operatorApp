-- A service site belongs to one physical BIN order/service line, not to the
-- customer or its commercial master contract. Existing rows are backfilled
-- from the legacy contract snapshot before the new columns become required.

ALTER TABLE mbt_contract_service_lines
  ADD COLUMN IF NOT EXISTS customer_site_profile_id uuid;

ALTER TABLE mbt_contract_service_lines
  ADD COLUMN IF NOT EXISTS site_snapshot jsonb;

UPDATE mbt_contract_service_lines AS line
   SET customer_site_profile_id = contract.customer_site_profile_id,
       site_snapshot = contract.site_snapshot
  FROM mbt_contracts AS contract
 WHERE contract.contract_id = line.contract_id
   AND (
     line.customer_site_profile_id IS NULL
     OR line.site_snapshot IS NULL
   );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM mbt_contract_service_lines
     WHERE customer_site_profile_id IS NULL
        OR site_snapshot IS NULL
  ) THEN
    RAISE EXCEPTION 'Every existing MBT BIN order must have a service site before migration 124 can continue';
  END IF;
END
$$;

ALTER TABLE mbt_contract_service_lines
  ALTER COLUMN customer_site_profile_id SET NOT NULL;

ALTER TABLE mbt_contract_service_lines
  ALTER COLUMN site_snapshot SET DEFAULT '{}'::jsonb;

ALTER TABLE mbt_contract_service_lines
  ALTER COLUMN site_snapshot SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'mbt_contract_service_lines_site_profile_fk'
       AND conrelid = 'mbt_contract_service_lines'::regclass
  ) THEN
    ALTER TABLE mbt_contract_service_lines
      ADD CONSTRAINT mbt_contract_service_lines_site_profile_fk
      FOREIGN KEY (customer_site_profile_id)
      REFERENCES mbt_customer_site_profiles(site_profile_id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'mbt_contract_service_lines_site_snapshot_object'
       AND conrelid = 'mbt_contract_service_lines'::regclass
  ) THEN
    ALTER TABLE mbt_contract_service_lines
      ADD CONSTRAINT mbt_contract_service_lines_site_snapshot_object
      CHECK (jsonb_typeof(site_snapshot) = 'object');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_mbt_contract_service_lines_site
  ON mbt_contract_service_lines (
    customer_site_profile_id,
    status,
    planned_delivery_at,
    service_line_id
  );

-- The legacy columns remain for old cached clients and historical rows. New
-- contracts leave them empty; operational site ownership is line-scoped.
ALTER TABLE mbt_contracts
  ALTER COLUMN customer_site_profile_id DROP NOT NULL;

COMMENT ON COLUMN mbt_contracts.customer_site_profile_id IS
  'Legacy compatibility summary only; new BIN contracts store service sites on mbt_contract_service_lines.';

COMMENT ON COLUMN mbt_contract_service_lines.customer_site_profile_id IS
  'Service site owned by this independently dispatchable physical BIN order.';
