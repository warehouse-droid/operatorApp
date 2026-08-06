-- User-defined BIN items and free-text customer-site asset addresses.
--
-- A local BIN item is now the user-facing source of truth. Its operational
-- mbt_bin_types row remains an internal compatibility binding used by Asset,
-- Front Desk, Dispatch, pricing, and Driver workflows.

SET LOCAL lock_timeout = '3s';

ALTER TABLE mbt_bin_types
  ADD COLUMN IF NOT EXISTS local_item_code text;

UPDATE mbt_bin_types type
   SET local_item_code = item.item_code,
       updated_at = now()
  FROM mbt_local_item_settings item
 WHERE item.item_type = 'bin'
   AND item.bin_type_id = type.bin_type_id
   AND type.local_item_code IS NULL;

ALTER TABLE mbt_bin_types
  DROP CONSTRAINT IF EXISTS mbt_bin_types_local_item_code_unique,
  DROP CONSTRAINT IF EXISTS mbt_bin_types_local_item_code_fk;

ALTER TABLE mbt_bin_types
  ADD CONSTRAINT mbt_bin_types_local_item_code_unique
    UNIQUE (local_item_code),
  ADD CONSTRAINT mbt_bin_types_local_item_code_fk
    FOREIGN KEY (local_item_code)
    REFERENCES mbt_local_item_settings(item_code)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_bin_binding_shape;

ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_bin_binding_shape
    CHECK (
      (item_type = 'bin' AND bin_type_id IS NOT NULL)
      OR (item_type <> 'bin' AND bin_type_id IS NULL)
    );

CREATE OR REPLACE FUNCTION mbt_validate_local_item_bin_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  configured_type text;
  configured_bin_type uuid;
  configured_item_code text;
BEGIN
  IF TG_TABLE_NAME = 'mbt_bin_types' THEN
    IF NEW.local_item_code IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT item_type, bin_type_id
      INTO configured_type, configured_bin_type
      FROM mbt_local_item_settings
     WHERE item_code = NEW.local_item_code;
    IF NOT FOUND
       OR configured_type <> 'bin'
       OR configured_bin_type IS DISTINCT FROM NEW.bin_type_id THEN
      RAISE EXCEPTION 'BIN type % must point to its bound local BIN item %',
        NEW.type_code, NEW.local_item_code
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.item_type <> 'bin' THEN
    IF NEW.bin_type_id IS NOT NULL THEN
      RAISE EXCEPTION 'non-BIN item % cannot own a BIN type', NEW.item_code
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT local_item_code
    INTO configured_item_code
    FROM mbt_bin_types
   WHERE bin_type_id = NEW.bin_type_id;
  IF NOT FOUND OR configured_item_code IS DISTINCT FROM NEW.item_code THEN
    RAISE EXCEPTION 'local BIN item % must own its operational BIN type', NEW.item_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_bin_types_local_item_binding ON mbt_bin_types;
CREATE CONSTRAINT TRIGGER trg_mbt_bin_types_local_item_binding
  AFTER INSERT OR UPDATE ON mbt_bin_types
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_local_item_bin_binding();

DROP TRIGGER IF EXISTS trg_mbt_local_items_bin_type_binding ON mbt_local_item_settings;
CREATE CONSTRAINT TRIGGER trg_mbt_local_items_bin_type_binding
  AFTER INSERT OR UPDATE ON mbt_local_item_settings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_local_item_bin_binding();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM mbt_local_item_settings item
      LEFT JOIN mbt_bin_types type
        ON type.bin_type_id = item.bin_type_id
       AND type.local_item_code = item.item_code
     WHERE item.item_type = 'bin'
       AND type.bin_type_id IS NULL
  ) THEN
    RAISE EXCEPTION 'existing local BIN items do not have one-to-one operational BIN-type bindings';
  END IF;
END;
$$;

-- A manually entered customer address is a valid customer_site location even
-- before a reusable customer-site profile exists. The immutable movement and
-- materialized state both retain the exact address in location_reference and
-- current_address; a later workflow may replace it with a profiled site.
ALTER TABLE mbt_bin_asset_state
  DROP CONSTRAINT IF EXISTS mbt_bin_asset_state_location_reference;

ALTER TABLE mbt_bin_asset_state
  ADD CONSTRAINT mbt_bin_asset_state_location_reference
    CHECK (
      (location_kind = 'yard' AND yard_id IS NOT NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NULL AND truck_id IS NULL)
      OR
      (location_kind = 'customer_site' AND yard_id IS NULL AND dump_site_id IS NULL AND truck_id IS NULL
        AND (customer_site_profile_id IS NOT NULL OR NULLIF(btrim(location_reference), '') IS NOT NULL))
      OR
      (location_kind = 'dump_site' AND yard_id IS NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NOT NULL AND truck_id IS NULL)
      OR
      (location_kind = 'truck' AND yard_id IS NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NULL AND truck_id IS NOT NULL)
      OR
      (location_kind = 'unknown' AND yard_id IS NULL AND customer_site_profile_id IS NULL AND dump_site_id IS NULL AND truck_id IS NULL)
    );

COMMENT ON COLUMN mbt_bin_types.local_item_code IS
  'Owning local BIN item. User-defined capacity is held in nominal_yards; the BIN type is an internal operational binding.';
COMMENT ON CONSTRAINT mbt_bin_asset_state_location_reference ON mbt_bin_asset_state IS
  'A customer_site may use a profiled site ID or a nonblank free-text address snapshot.';
