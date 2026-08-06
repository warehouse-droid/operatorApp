-- MBT item-owned asset identity and materialized current-address tracking.
-- Historical QR/barcode/home-yard/tare/note columns remain in place only so
-- previously recorded evidence and cached clients can still be read safely.

DROP TRIGGER IF EXISTS trg_mbt_local_item_settings_guard
  ON mbt_local_item_settings;

ALTER TABLE mbt_local_item_settings
  ADD COLUMN IF NOT EXISTS item_type text,
  ADD COLUMN IF NOT EXISTS rental_period_days integer;

UPDATE mbt_local_item_settings
   SET item_type = CASE
         WHEN category = 'bin_charge' THEN 'bin'
         WHEN category = 'dump' THEN 'dump'
         WHEN category IN ('surcharge', 'discount') THEN 'surcharge'
         ELSE 'delivery_fee'
       END,
       rental_period_days = CASE
         WHEN category = 'bin_charge' THEN 14
         ELSE NULL
       END,
       revision = revision + 1,
       updated_by = 'migration:125',
       updated_at = now()
 WHERE item_type IS NULL
    OR (category = 'bin_charge' AND rental_period_days IS NULL);

ALTER TABLE mbt_local_item_settings
  ALTER COLUMN item_type SET NOT NULL;

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_item_type;
ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_item_type
    CHECK (item_type IN ('bin', 'surcharge', 'dump', 'delivery_fee'));

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_rental_period;
ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_rental_period
    CHECK (
      (item_type = 'bin' AND rental_period_days IS NOT NULL AND rental_period_days > 0)
      OR (item_type <> 'bin' AND rental_period_days IS NULL)
    );

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_system_identity;

UPDATE mbt_local_item_settings
   SET pricing_mode = 'rate_card',
       revision = revision + 1,
       updated_by = 'migration:125',
       updated_at = now()
 WHERE item_code IN ('DELIVERY_CROSS_CHARGE', 'DUMP')
   AND pricing_mode IS DISTINCT FROM 'rate_card';

ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_system_identity
    CHECK (
      NOT system_owned
      OR (
        item_code = 'DELIVERY_CROSS_CHARGE'
        AND item_type = 'delivery_fee'
        AND category = 'cross_charge'
        AND bin_type_id IS NULL
        AND pricing_mode = 'rate_card'
        AND rental_period_days IS NULL
        AND netsuite_mapping_local_key = 'delivery_charge'
      )
      OR (
        item_code = '14YD'
        AND item_type = 'bin'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000014'::uuid
        AND pricing_mode = 'rental_item'
        AND rental_period_days = 14
        AND netsuite_mapping_local_key = 'bin_14yd'
      )
      OR (
        item_code = '20YD'
        AND item_type = 'bin'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000020'::uuid
        AND pricing_mode = 'rental_item'
        AND rental_period_days = 14
        AND netsuite_mapping_local_key = 'bin_20yd'
      )
      OR (
        item_code = '40YD'
        AND item_type = 'bin'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000040'::uuid
        AND pricing_mode = 'rental_item'
        AND rental_period_days = 14
        AND netsuite_mapping_local_key = 'bin_40yd'
      )
      OR (
        item_code = 'DUMP'
        AND item_type = 'dump'
        AND category = 'dump'
        AND bin_type_id IS NULL
        AND pricing_mode = 'rate_card'
        AND rental_period_days IS NULL
        AND netsuite_mapping_local_key IS NULL
      )
    );

ALTER TABLE mbt_bin_assets
  ADD COLUMN IF NOT EXISTS item_code text
    REFERENCES mbt_local_item_settings(item_code) ON DELETE RESTRICT;

UPDATE mbt_bin_assets asset
   SET item_code = (
    SELECT setting.item_code
      FROM mbt_local_item_settings setting
     WHERE setting.bin_type_id = asset.bin_type_id
       AND setting.item_type = 'bin'
     ORDER BY setting.system_owned DESC, setting.item_code
     LIMIT 1
   )
 WHERE asset.item_code IS NULL
   AND EXISTS (
     SELECT 1
       FROM mbt_local_item_settings setting
      WHERE setting.bin_type_id = asset.bin_type_id
        AND setting.item_type = 'bin'
   );

ALTER TABLE mbt_bin_assets
  ALTER COLUMN home_yard_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mbt_bin_assets_item
  ON mbt_bin_assets (item_code, active, under_maintenance, asset_code);

CREATE OR REPLACE FUNCTION mbt_validate_asset_item_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  configured_type text;
  configured_bin_type uuid;
BEGIN
  IF NEW.item_code IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT item_type, bin_type_id
    INTO configured_type, configured_bin_type
    FROM mbt_local_item_settings
   WHERE item_code = NEW.item_code;

  IF NOT FOUND
     OR configured_type <> 'bin'
     OR configured_bin_type IS NULL
     OR configured_bin_type IS DISTINCT FROM NEW.bin_type_id THEN
    RAISE EXCEPTION 'bin asset item % must be an item_type=bin row bound to bin type %',
      NEW.item_code, NEW.bin_type_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_bin_assets_item_binding ON mbt_bin_assets;
CREATE TRIGGER trg_mbt_bin_assets_item_binding
  BEFORE INSERT OR UPDATE OF item_code, bin_type_id ON mbt_bin_assets
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_asset_item_binding();

ALTER TABLE mbt_bin_movements
  ADD COLUMN IF NOT EXISTS before_address text,
  ADD COLUMN IF NOT EXISTS after_address text;

ALTER TABLE mbt_bin_asset_state
  ADD COLUMN IF NOT EXISTS current_address text NOT NULL DEFAULT 'Unknown';

-- Install the non-blank invariant before backfilling existing state rows.
-- Updating a state row fires the pre-existing deferred ledger/state trigger;
-- PostgreSQL will reject a later ALTER TABLE in the same transaction while
-- those trigger events are pending. The default already satisfies this check,
-- so validating it before the backfill is both safe and upgrade-compatible.
ALTER TABLE mbt_bin_asset_state
  DROP CONSTRAINT IF EXISTS mbt_bin_asset_state_current_address_not_blank;
ALTER TABLE mbt_bin_asset_state
  ADD CONSTRAINT mbt_bin_asset_state_current_address_not_blank
    CHECK (NULLIF(btrim(current_address), '') IS NOT NULL);

UPDATE mbt_bin_asset_state state
   SET current_address = CASE state.location_kind
     WHEN 'yard' THEN COALESCE((
       SELECT NULLIF(concat_ws(', ',
         NULLIF(yard.address_line_1, ''), NULLIF(yard.address_line_2, ''),
         NULLIF(yard.city, ''), NULLIF(yard.region, ''), NULLIF(yard.postal_code, '')
       ), '')
         FROM mbt_yards yard
        WHERE yard.yard_id = state.yard_id
     ), NULLIF(state.location_reference, ''), 'Unknown')
     WHEN 'customer_site' THEN COALESCE((
       SELECT NULLIF(concat_ws(', ',
         NULLIF(address.address_line_1, ''), NULLIF(address.address_line_2, ''),
         NULLIF(address.address_line_3, ''), NULLIF(address.city, ''),
         NULLIF(address.region, ''), NULLIF(address.postal_code, '')
       ), '')
         FROM mbt_customer_site_profiles site
         JOIN netsuite_customer_addresses address
           ON address.customer_netsuite_id = site.customer_netsuite_id
          AND address.address_id = site.address_id
        WHERE site.site_profile_id = state.customer_site_profile_id
     ), NULLIF(state.location_reference, ''), 'Unknown')
     WHEN 'dump_site' THEN COALESCE((
       SELECT NULLIF(concat_ws(', ',
         NULLIF(site.address_line_1, ''), NULLIF(site.address_line_2, ''),
         NULLIF(site.city, ''), NULLIF(site.region, ''), NULLIF(site.postal_code, '')
       ), '')
         FROM mbt_dump_sites site
        WHERE site.dump_site_id = state.dump_site_id
     ), NULLIF(state.location_reference, ''), 'Unknown')
     WHEN 'truck' THEN COALESCE((
       SELECT 'In transit on ' || truck.plate
         FROM dispatch_trucks truck
        WHERE truck.id = state.truck_id
     ), NULLIF(state.location_reference, ''), 'In transit')
     ELSE COALESCE(NULLIF(state.location_reference, ''), 'Unknown')
   END;

-- Extend the existing deferred ledger/state invariant. Old ledger rows have no
-- address snapshot; every new movement does, and is checked exactly.
CREATE OR REPLACE FUNCTION mbt_assert_bin_asset_state_matches_latest(p_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_state mbt_bin_asset_state%ROWTYPE;
  latest_movement mbt_bin_movements%ROWTYPE;
  expected_truck_id bigint;
BEGIN
  SELECT * INTO current_state
    FROM mbt_bin_asset_state
   WHERE asset_id = p_asset_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bin asset % has movement history without materialized state', p_asset_id
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO latest_movement
    FROM mbt_bin_movements
   WHERE asset_id = p_asset_id
   ORDER BY asset_sequence DESC, movement_id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bin asset % has materialized state without movement history', p_asset_id
      USING ERRCODE = '55000';
  END IF;

  expected_truck_id := CASE
    WHEN latest_movement.after_location_kind = 'truck' THEN latest_movement.truck_id
    ELSE NULL
  END;

  IF current_state.last_movement_id IS DISTINCT FROM latest_movement.movement_id
     OR current_state.revision IS DISTINCT FROM latest_movement.asset_sequence
     OR current_state.lifecycle_status IS DISTINCT FROM latest_movement.after_status
     OR current_state.location_kind IS DISTINCT FROM latest_movement.after_location_kind
     OR current_state.location_reference IS DISTINCT FROM latest_movement.after_location_reference
     OR current_state.yard_id IS DISTINCT FROM latest_movement.to_yard_id
     OR current_state.customer_site_profile_id IS DISTINCT FROM latest_movement.to_customer_site_profile_id
     OR current_state.dump_site_id IS DISTINCT FROM latest_movement.to_dump_site_id
     OR current_state.truck_id IS DISTINCT FROM expected_truck_id
     OR (
       latest_movement.after_address IS NOT NULL
       AND current_state.current_address IS DISTINCT FROM latest_movement.after_address
     ) THEN
    RAISE EXCEPTION 'bin asset state % must exactly match its latest movement %',
      p_asset_id, latest_movement.movement_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

COMMENT ON COLUMN mbt_bin_assets.item_code IS
  'The active local item that defines this physical bin asset. bin_type_id remains the operational compatibility key.';
COMMENT ON COLUMN mbt_bin_assets.home_yard_id IS
  'Deprecated historical attribute. New registrations use the movement/state current location instead.';
COMMENT ON COLUMN mbt_bin_asset_state.current_address IS
  'Server-resolved materialized address of the latest movement location.';
COMMENT ON COLUMN mbt_bin_movements.after_address IS
  'Immutable server-resolved address snapshot for the destination of this movement.';

CREATE OR REPLACE FUNCTION mbt_guard_local_item_setting_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MBT local item settings cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.item_code IS DISTINCT FROM OLD.item_code
     OR NEW.system_owned IS DISTINCT FROM OLD.system_owned
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MBT local item identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.system_owned AND (
       NEW.item_type IS DISTINCT FROM OLD.item_type
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.bin_type_id IS DISTINCT FROM OLD.bin_type_id
       OR NEW.pricing_mode IS DISTINCT FROM OLD.pricing_mode
       OR NEW.rental_period_days IS DISTINCT FROM OLD.rental_period_days
       OR NEW.netsuite_mapping_local_key IS DISTINCT FROM OLD.netsuite_mapping_local_key
       OR NEW.applicable_service_types IS DISTINCT FROM OLD.applicable_service_types
       OR NEW.applicable_legacy_source_types IS DISTINCT FROM OLD.applicable_legacy_source_types
     ) THEN
    RAISE EXCEPTION 'MBT protected local item identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'MBT local item revisions must advance exactly once per update'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mbt_local_item_settings_guard
  BEFORE UPDATE OR DELETE ON mbt_local_item_settings
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_local_item_setting_mutation();
