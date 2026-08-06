-- Phase 3 shared Dispatch master data and local reference configuration.
-- This migration is additive and local-only: it does not enable a capability,
-- import a file, mutate an operational plan, or contact an external system.

SET LOCAL lock_timeout = '3s';

-- Preserve the exact precision already held by Dispatch setup rather than
-- rounding the Kennedy Road coordinates to the Phase 1 six-decimal typmod.
ALTER TABLE mbt_yards
  ALTER COLUMN latitude TYPE numeric USING latitude::numeric,
  ALTER COLUMN longitude TYPE numeric USING longitude::numeric;

ALTER TABLE mbt_dump_sites
  ALTER COLUMN latitude TYPE numeric USING latitude::numeric,
  ALTER COLUMN longitude TYPE numeric USING longitude::numeric;

ALTER TABLE mbt_yards
  ADD COLUMN IF NOT EXISTS dispatch_location_id integer;

INSERT INTO mbt_yards (
  yard_id,
  yard_code,
  dispatch_location_id,
  display_name,
  address_line_1,
  address_line_2,
  city,
  region,
  postal_code,
  country_code,
  timezone,
  latitude,
  longitude,
  active,
  revision,
  created_by,
  updated_by
)
VALUES
  (
    '00000000-0000-4000-8000-000000012441', '12441', 15, '12441',
    '12441 Woodbine Avenue, Whitchurch-Stouffville, ON', '', '', '', '', 'CA',
    'America/Toronto', 43.948694, -79.372758, true, 1,
    'migration:112', 'migration:112'
  ),
  (
    '00000000-0000-4000-8000-000000003445', '3445', 1, '3445',
    '3445 Kennedy Road, Toronto, ON', '', '', '', '', 'CA',
    'America/Toronto', 43.8204306, -79.3053423, true, 1,
    'migration:112', 'migration:112'
  ),
  (
    '00000000-0000-4000-8000-000000002967', '2967', 28, '2967',
    '2967 Kennedy Road, Toronto, ON', '', '', '', '', 'CA',
    'America/Toronto', 43.806119, -79.2986377, true, 1,
    'migration:112', 'migration:112'
  ),
  (
    '00000000-0000-4000-8000-000000000150', '150', 26, '150',
    '150 Clark Blvd, Brampton, ON L6T 4Y8, Canada', '', '', '', '', 'CA',
    'America/Toronto', NULL, NULL, true, 1,
    'migration:112', 'migration:112'
  )
ON CONFLICT (yard_code) DO UPDATE
SET dispatch_location_id = EXCLUDED.dispatch_location_id
WHERE mbt_yards.dispatch_location_id IS NULL;

DO $$
DECLARE
  mapping_count integer;
BEGIN
  SELECT count(*)::integer INTO mapping_count
    FROM mbt_yards
   WHERE (yard_code, dispatch_location_id) IN (
     ('12441', 15), ('3445', 1), ('2967', 28), ('150', 26)
   );
  IF mapping_count <> 4 THEN
    RAISE EXCEPTION 'Existing Dispatch own-yard identities conflict with the Phase 3 shared-yard mapping'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE mbt_yards
  ALTER COLUMN dispatch_location_id SET NOT NULL;

ALTER TABLE mbt_yards
  DROP CONSTRAINT IF EXISTS mbt_yards_dispatch_location_positive,
  DROP CONSTRAINT IF EXISTS mbt_yards_dispatch_location_unique;

ALTER TABLE mbt_yards
  ADD CONSTRAINT mbt_yards_dispatch_location_positive
    CHECK (dispatch_location_id > 0),
  ADD CONSTRAINT mbt_yards_dispatch_location_unique
    UNIQUE (dispatch_location_id);

ALTER TABLE dispatch_trucks
  ADD COLUMN IF NOT EXISTS truck_type text NOT NULL DEFAULT 'flatbed',
  ADD COLUMN IF NOT EXISTS base_yard_id uuid REFERENCES mbt_yards(yard_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;

-- Migration-time intent is explicit: no existing fleet row becomes BIN work.
-- The constraint-name sentinel is absent only on the first successful install;
-- an exact SQL rerun therefore validates but never resets later configuration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'dispatch_trucks'::regclass
       AND conname = 'dispatch_trucks_type'
  ) THEN
    UPDATE dispatch_trucks
       SET truck_type = 'flatbed',
           bin_service_enabled = false,
           bin_slot_capacity = 0,
           base_yard_id = NULL,
           revision = GREATEST(revision, 1);

    UPDATE dispatch_truck_bin_types
       SET active = false,
           updated_at = now()
     WHERE active;
  END IF;
END;
$$;

ALTER TABLE dispatch_trucks
  DROP CONSTRAINT IF EXISTS dispatch_trucks_type,
  DROP CONSTRAINT IF EXISTS dispatch_trucks_revision_positive,
  DROP CONSTRAINT IF EXISTS dispatch_trucks_bin_projection,
  DROP CONSTRAINT IF EXISTS dispatch_trucks_type_capability;

ALTER TABLE dispatch_trucks
  ADD CONSTRAINT dispatch_trucks_type
    CHECK (truck_type IN ('flatbed', 'bin')),
  ADD CONSTRAINT dispatch_trucks_revision_positive
    CHECK (revision > 0),
  ADD CONSTRAINT dispatch_trucks_bin_projection
    CHECK (bin_service_enabled = (truck_type = 'bin')),
  ADD CONSTRAINT dispatch_trucks_type_capability
    CHECK (
      (
        truck_type = 'flatbed'
        AND bin_slot_capacity = 0
        AND base_yard_id IS NULL
      )
      OR
      (
        truck_type = 'bin'
        AND bin_slot_capacity > 0
        AND base_yard_id IS NOT NULL
      )
    );

CREATE TABLE IF NOT EXISTS dispatch_truck_capability_history (
  capability_history_id uuid PRIMARY KEY,
  truck_id bigint NOT NULL REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  revision bigint NOT NULL,
  capability_snapshot jsonb NOT NULL,
  actor_operator_id text NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_truck_capability_history_revision_positive
    CHECK (revision > 0),
  CONSTRAINT dispatch_truck_capability_history_snapshot_object
    CHECK (jsonb_typeof(capability_snapshot) = 'object'),
  CONSTRAINT dispatch_truck_capability_history_actor_not_blank
    CHECK (NULLIF(btrim(actor_operator_id), '') IS NOT NULL),
  CONSTRAINT dispatch_truck_capability_history_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT dispatch_truck_capability_history_key_not_blank
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL),
  CONSTRAINT dispatch_truck_capability_history_revision_unique
    UNIQUE (truck_id, revision)
);

CREATE OR REPLACE FUNCTION mbt_assert_dispatch_truck_capability(p_truck_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  truck_row dispatch_trucks%ROWTYPE;
  active_size_count integer;
BEGIN
  SELECT * INTO truck_row
    FROM dispatch_trucks
   WHERE id = p_truck_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO active_size_count
    FROM dispatch_truck_bin_types
   WHERE truck_id = p_truck_id
     AND active;

  IF truck_row.truck_type = 'flatbed' AND active_size_count <> 0 THEN
    RAISE EXCEPTION 'Flatbed truck % cannot have active BIN sizes', p_truck_id
      USING ERRCODE = '55000';
  END IF;
  IF truck_row.truck_type = 'bin' AND active_size_count < 1 THEN
    RAISE EXCEPTION 'Bin truck % requires an active supported BIN size', p_truck_id
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION mbt_validate_dispatch_truck_capability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'dispatch_trucks' THEN
    PERFORM mbt_assert_dispatch_truck_capability(
      CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END
    );
  ELSE
    PERFORM mbt_assert_dispatch_truck_capability(
      CASE WHEN TG_OP = 'DELETE' THEN OLD.truck_id ELSE NEW.truck_id END
    );
    IF TG_OP = 'UPDATE' AND NEW.truck_id IS DISTINCT FROM OLD.truck_id THEN
      PERFORM mbt_assert_dispatch_truck_capability(OLD.truck_id);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dispatch_trucks_capability_coherent
  ON dispatch_trucks;
CREATE CONSTRAINT TRIGGER trg_dispatch_trucks_capability_coherent
  AFTER INSERT OR UPDATE OR DELETE ON dispatch_trucks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_dispatch_truck_capability();

DROP TRIGGER IF EXISTS trg_dispatch_truck_bin_types_coherent
  ON dispatch_truck_bin_types;
CREATE CONSTRAINT TRIGGER trg_dispatch_truck_bin_types_coherent
  AFTER INSERT OR UPDATE OR DELETE ON dispatch_truck_bin_types
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_dispatch_truck_capability();

ALTER TABLE mbt_local_item_settings
  ADD COLUMN IF NOT EXISTS system_owned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS applicable_service_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS applicable_legacy_source_types text[] NOT NULL DEFAULT ARRAY[]::text[];

UPDATE mbt_local_item_settings
   SET system_owned = true,
       applicable_legacy_source_types = CASE
         WHEN item_code = 'DELIVERY_CROSS_CHARGE'
           THEN ARRAY['SO', 'TO', 'PO', 'VRMA']::text[]
         ELSE ARRAY[]::text[]
       END,
       revision = revision + 1,
       updated_by = 'migration:112',
       updated_at = now()
 WHERE item_code IN ('DELIVERY_CROSS_CHARGE', '14YD', '20YD', '40YD', 'DUMP')
   AND (
     system_owned IS DISTINCT FROM true
     OR applicable_legacy_source_types IS DISTINCT FROM CASE
       WHEN item_code = 'DELIVERY_CROSS_CHARGE'
         THEN ARRAY['SO', 'TO', 'PO', 'VRMA']::text[]
       ELSE ARRAY[]::text[]
     END
   );

ALTER TABLE mbt_local_item_settings
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_code,
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_category,
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_identity_shape,
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_code_format,
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_source_shapes,
  DROP CONSTRAINT IF EXISTS mbt_local_item_settings_system_identity;

ALTER TABLE mbt_local_item_settings
  ADD CONSTRAINT mbt_local_item_settings_code_format
    CHECK (item_code ~ '^[A-Z0-9][A-Z0-9_]{0,63}$'),
  ADD CONSTRAINT mbt_local_item_settings_category
    CHECK (category IN (
      'bin_charge', 'dump', 'service', 'surcharge', 'discount',
      'cross_charge', 'other'
    )),
  ADD CONSTRAINT mbt_local_item_settings_source_shapes
    CHECK (
      applicable_service_types <@ ARRAY[
        'delivery', 'final_pickup', 'loaded_pickup', 'dump_return', 'exchange'
      ]::text[]
      AND applicable_legacy_source_types <@ ARRAY['SO', 'TO', 'PO', 'VRMA']::text[]
    ),
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
        AND pricing_mode = 'rate_card'
        AND netsuite_mapping_local_key = 'bin_14yd'
      )
      OR (
        item_code = '20YD'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000020'::uuid
        AND pricing_mode = 'rate_card'
        AND netsuite_mapping_local_key = 'bin_20yd'
      )
      OR (
        item_code = '40YD'
        AND category = 'bin_charge'
        AND bin_type_id = '00000000-0000-4000-8000-000000000040'::uuid
        AND pricing_mode = 'rate_card'
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
       NEW.category IS DISTINCT FROM OLD.category
       OR NEW.bin_type_id IS DISTINCT FROM OLD.bin_type_id
       OR NEW.pricing_mode IS DISTINCT FROM OLD.pricing_mode
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

COMMENT ON COLUMN mbt_yards.dispatch_location_id IS
  'Positive external Dispatch/NetSuite location identity; never an MBT yard UUID.';

COMMENT ON COLUMN dispatch_trucks.truck_type IS
  'User-facing fleet type. bin_service_enabled is its derived compatibility projection.';

COMMENT ON COLUMN mbt_local_item_settings.system_owned IS
  'Protected migration-owned identities remain immutable; custom rows use the same local catalog.';
