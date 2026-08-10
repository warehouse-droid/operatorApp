-- Make the customer charging unit an explicit property of each local item.
-- Existing price rows remain immutable evidence; this setting constrains only
-- new configuration and current Front Desk selection.

ALTER TABLE mbt_local_item_settings
  ADD COLUMN IF NOT EXISTS charge_basis text,
  ADD COLUMN IF NOT EXISTS density_lbs_per_yard integer;

UPDATE mbt_local_item_settings
   SET charge_basis = CASE item_type
         WHEN 'bin' THEN 'rental_period'
         WHEN 'surcharge' THEN 'per_event'
         WHEN 'dump' THEN 'per_tonne'
         WHEN 'delivery_fee' THEN 'distance'
       END,
       revision = revision + 1,
       updated_by = 'migration:143',
       updated_at = now()
 WHERE charge_basis IS NULL;

-- The item table has deferred immutability/reference checks. Fire the
-- backfill events before changing table constraints in this transaction.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE mbt_local_item_settings
  ALTER COLUMN charge_basis SET NOT NULL;

-- Preserve established insert shapes that predate the column. Application
-- commands always send the explicit basis; this trigger gives older internal
-- paths the same safe type-owned default instead of breaking them.
CREATE OR REPLACE FUNCTION mbt_default_local_item_charge_basis()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.charge_basis IS NULL THEN
    NEW.charge_basis := CASE NEW.item_type
      WHEN 'bin' THEN 'rental_period'
      WHEN 'surcharge' THEN 'per_event'
      WHEN 'dump' THEN 'per_tonne'
      WHEN 'aggregate' THEN 'per_yard'
      WHEN 'delivery_fee' THEN 'distance'
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_default_local_item_charge_basis
  ON mbt_local_item_settings;
CREATE TRIGGER trg_mbt_default_local_item_charge_basis
BEFORE INSERT ON mbt_local_item_settings
FOR EACH ROW EXECUTE FUNCTION mbt_default_local_item_charge_basis();

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_item_type;
ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_item_type
    CHECK (item_type IN ('bin', 'surcharge', 'dump', 'aggregate', 'delivery_fee'));

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_charge_basis;
ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_charge_basis
    CHECK (
      (item_type = 'bin' AND charge_basis = 'rental_period')
      OR (item_type = 'surcharge' AND charge_basis = 'per_event')
      OR (item_type = 'dump' AND charge_basis IN ('per_tonne', 'per_bin'))
      OR (item_type = 'aggregate' AND charge_basis = 'per_yard')
      OR (item_type = 'delivery_fee' AND charge_basis = 'distance')
    );

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_aggregate_density;
ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_aggregate_density
    CHECK (
      (item_type = 'aggregate' AND density_lbs_per_yard IS NOT NULL AND density_lbs_per_yard > 0)
      OR (item_type <> 'aggregate' AND density_lbs_per_yard IS NULL)
    );

CREATE OR REPLACE FUNCTION mbt_validate_item_owned_rate_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  configured_type text;
  configured_basis text;
BEGIN
  IF NEW.item_code IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT item_type, charge_basis INTO configured_type, configured_basis
    FROM mbt_local_item_settings
   WHERE item_code = NEW.item_code;

  IF TG_TABLE_NAME = 'mbt_rate_distance_bands'
     AND configured_type IS DISTINCT FROM 'delivery_fee' THEN
    RAISE EXCEPTION 'distance-band item % must have item_type=delivery_fee', NEW.item_code
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'mbt_dump_tariffs' THEN
    IF configured_type NOT IN ('dump', 'aggregate') THEN
      RAISE EXCEPTION 'unit-tariff item % must have item_type=dump or aggregate', NEW.item_code
        USING ERRCODE = '23514';
    ELSIF configured_type = 'aggregate'
       AND (NEW.pricing_basis <> 'per_quantity' OR upper(NEW.unit_of_measure) <> 'YARD') THEN
      RAISE EXCEPTION 'aggregate tariff % must be per_quantity/YARD', NEW.item_code
        USING ERRCODE = '23514';
    ELSIF configured_type = 'dump' AND configured_basis = 'per_bin'
       AND (NEW.pricing_basis <> 'per_quantity' OR upper(NEW.unit_of_measure) <> 'BIN') THEN
      RAISE EXCEPTION 'fixed-bin dump tariff % must be per_quantity/BIN', NEW.item_code
        USING ERRCODE = '23514';
    ELSIF configured_type = 'dump' AND configured_basis = 'per_tonne'
       AND (NEW.pricing_basis NOT IN ('per_weight', 'per_quantity') OR upper(NEW.unit_of_measure) <> 'TONNE') THEN
      RAISE EXCEPTION 'weighed dump tariff % must use TONNE', NEW.item_code
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'mbt_rate_components'
     AND COALESCE(to_jsonb(NEW)->>'component_kind', '') IN ('rental', 'extension')
     AND configured_type IS DISTINCT FROM 'bin' THEN
    RAISE EXCEPTION 'rental component item % must have item_type=bin', NEW.item_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN mbt_local_item_settings.charge_basis IS
  'Current operator-selected customer charging unit. Activated historical rates retain their own immutable basis and UOM.';
COMMENT ON COLUMN mbt_local_item_settings.density_lbs_per_yard IS
  'Required server-owned dispatch weight conversion for aggregate items; not a customer price.';
COMMENT ON TABLE mbt_dump_tariffs IS
  'Item-owned unit tariffs. The historical table name is retained; rows may price Dump or Aggregate local items.';
