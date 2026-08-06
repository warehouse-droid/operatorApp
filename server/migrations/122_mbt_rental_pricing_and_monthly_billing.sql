-- MBT Phase 4 local rental-pricing foundation.
-- This is deliberately local-only: no NetSuite mapping, outbox, transport,
-- scheduler, or external write is introduced by this migration.

-- The three physical rental bins are not generic rate-card items.  Their
-- identity is still immutable, but their pricing now has an explicit local
-- rental mode so the operator UI can reliably present the first 14 calendar
-- days and the extension-per-day rule.
DROP TRIGGER IF EXISTS trg_mbt_local_item_settings_guard
  ON mbt_local_item_settings;

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_pricing_mode;
ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_pricing_mode
    CHECK (pricing_mode IN ('calculated', 'rate_card', 'rental_item', 'custom_price'));

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_system_identity;

UPDATE mbt_local_item_settings
   SET pricing_mode = 'rental_item',
       description = CASE
         WHEN description = 'Price comes from the approved rate card.'
           THEN 'Fixed 14-day rental and extension price come from the approved local rate card.'
         ELSE description
       END,
       revision = revision + 1,
       updated_by = 'migration:122',
       updated_at = now()
 WHERE item_code IN ('14YD', '20YD', '40YD')
   AND pricing_mode IS DISTINCT FROM 'rental_item';

ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_system_identity
    CHECK (
      NOT system_owned
      OR (
        item_code = 'DELIVERY_CROSS_CHARGE'
        AND category = 'cross_charge'
        AND bin_type_id IS NULL
        AND pricing_mode = 'calculated'
        AND netsuite_mapping_local_key = 'delivery_charge'
      )
      OR (
        item_code = '14YD'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000014'::uuid
        AND pricing_mode = 'rental_item'
        AND netsuite_mapping_local_key = 'bin_14yd'
      )
      OR (
        item_code = '20YD'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000020'::uuid
        AND pricing_mode = 'rental_item'
        AND netsuite_mapping_local_key = 'bin_20yd'
      )
      OR (
        item_code = '40YD'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000040'::uuid
        AND pricing_mode = 'rental_item'
        AND netsuite_mapping_local_key = 'bin_40yd'
      )
      OR (
        item_code = 'DUMP'
        AND category = 'dump'
        AND bin_type_id IS NULL
        AND pricing_mode = 'custom_price'
        AND netsuite_mapping_local_key IS NULL
      )
    );

CREATE TRIGGER trg_mbt_local_item_settings_guard
  BEFORE UPDATE OR DELETE ON mbt_local_item_settings
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_local_item_setting_mutation();

-- A customer charge is global by material and weight.  The actual dump-site
-- receipt remains a separate immutable cost record, allowing margin to be
-- calculated without leaking a particular dump site's cost into the tariff.
ALTER TABLE mbt_dump_tariffs
  ALTER COLUMN dump_site_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_mbt_dump_tariffs_scope_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_dump_tariffs_scope_unique
  ON mbt_dump_tariffs (
    rate_card_version_id,
    COALESCE(dump_site_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(material_id, '00000000-0000-0000-0000-000000000000'::uuid),
    tariff_code
  );

CREATE INDEX IF NOT EXISTS idx_mbt_billing_cases_toronto_month
  ON mbt_billing_cases (case_type, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mbt_service_visits_actual_completed
  ON mbt_service_visits (actual_completed_at DESC)
  WHERE actual_completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mbt_cross_charge_completed_load
  ON mbt_cross_charge_cases (completed_load_at DESC)
  WHERE completed_load_at IS NOT NULL;

COMMENT ON COLUMN mbt_local_item_settings.pricing_mode IS
  'Local ownership mode. rental_item means fixed first-14-day rental plus an extension-per-day component.';
COMMENT ON COLUMN mbt_dump_tariffs.dump_site_id IS
  'Optional. NULL denotes a customer tariff that applies globally by material; receipt cost remains site-specific.';
