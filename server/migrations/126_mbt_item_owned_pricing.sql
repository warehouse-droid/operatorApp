-- MBT item-owned pricing and dump-site acceptance.
--
-- mbt_materials and mbt_dump_site_materials remain as compatibility
-- projections for already-deployed Driver, Dispatch, receipt, and billing
-- workflows. Operators configure only local items after this migration.

INSERT INTO mbt_local_item_settings (
  item_code, display_name, description, item_type, rental_period_days,
  category, bin_type_id, pricing_mode, netsuite_mapping_local_key,
  system_owned, applicable_service_types, applicable_legacy_source_types,
  active, revision, created_by, updated_by
)
SELECT material.material_code,
       material.display_name,
       material.description,
       'dump',
       NULL,
       'dump',
       NULL,
       'rate_card',
       NULL,
       false,
       ARRAY['dump_return']::text[],
       ARRAY[]::text[],
       material.active,
       1,
       'migration:126',
       'migration:126'
  FROM mbt_materials material
 WHERE material.material_code ~ '^[A-Z0-9][A-Z0-9_]{0,63}$'
ON CONFLICT (item_code) DO NOTHING;

INSERT INTO mbt_materials (
  material_id, material_code, display_name, description, active,
  revision, created_by, updated_by
)
SELECT gen_random_uuid(), item.item_code, item.display_name, item.description,
       item.active, 1, 'migration:126', 'migration:126'
  FROM mbt_local_item_settings item
 WHERE item.item_type = 'dump'
ON CONFLICT (material_code) DO NOTHING;

CREATE TABLE mbt_dump_site_items (
  dump_site_item_id uuid PRIMARY KEY,
  dump_site_id uuid NOT NULL REFERENCES mbt_dump_sites(dump_site_id) ON DELETE RESTRICT,
  item_code text NOT NULL REFERENCES mbt_local_item_settings(item_code) ON DELETE RESTRICT,
  accepted boolean NOT NULL DEFAULT true,
  scale_ticket_required boolean NOT NULL DEFAULT true,
  operational_notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_dump_site_items_revision_positive CHECK (revision > 0),
  CONSTRAINT mbt_dump_site_items_site_item_unique UNIQUE (dump_site_id, item_code)
);

INSERT INTO mbt_dump_site_items (
  dump_site_item_id, dump_site_id, item_code, accepted,
  scale_ticket_required, operational_notes, active, revision,
  created_by, updated_by, created_at, updated_at
)
SELECT gen_random_uuid(), acceptance.dump_site_id, item.item_code,
       acceptance.accepted, acceptance.scale_ticket_required,
       acceptance.operational_notes, acceptance.active, acceptance.revision,
       COALESCE(acceptance.created_by, 'migration:126'),
       COALESCE(acceptance.updated_by, 'migration:126'),
       acceptance.created_at, acceptance.updated_at
  FROM mbt_dump_site_materials acceptance
  JOIN mbt_materials material USING (material_id)
  JOIN mbt_local_item_settings item
    ON item.item_code = material.material_code
   AND item.item_type = 'dump'
ON CONFLICT (dump_site_id, item_code) DO NOTHING;

ALTER TABLE mbt_rate_distance_bands
  ADD COLUMN IF NOT EXISTS item_code text
    REFERENCES mbt_local_item_settings(item_code) ON DELETE RESTRICT;
ALTER TABLE mbt_rate_components
  ADD COLUMN IF NOT EXISTS item_code text
    REFERENCES mbt_local_item_settings(item_code) ON DELETE RESTRICT;
ALTER TABLE mbt_dump_tariffs
  ADD COLUMN IF NOT EXISTS item_code text
    REFERENCES mbt_local_item_settings(item_code) ON DELETE RESTRICT;

UPDATE mbt_rate_distance_bands
   SET item_code = 'DELIVERY_CROSS_CHARGE'
 WHERE item_code IS NULL
   -- A used rate version and every historical child row are immutable. Those
   -- rows continue to project the legacy delivery item at read time; only
   -- unused versions are annotated in place.
   AND NOT EXISTS (
     SELECT 1
       FROM mbt_rate_card_versions version
      WHERE version.rate_card_version_id = mbt_rate_distance_bands.rate_card_version_id
        AND version.first_used_at IS NOT NULL
   )
   AND EXISTS (
     SELECT 1 FROM mbt_local_item_settings
      WHERE item_code = 'DELIVERY_CROSS_CHARGE'
        AND item_type = 'delivery_fee'
   );

UPDATE mbt_rate_components component
   SET item_code = (
     SELECT item.item_code
       FROM mbt_local_item_settings item
      WHERE item.item_type = 'bin'
        AND item.bin_type_id = component.bin_type_id
      ORDER BY item.system_owned DESC, item.item_code
      LIMIT 1
   )
 WHERE component.item_code IS NULL
   AND component.bin_type_id IS NOT NULL
   AND component.component_kind IN ('rental', 'extension')
   AND NOT EXISTS (
     SELECT 1
       FROM mbt_rate_card_versions version
      WHERE version.rate_card_version_id = component.rate_card_version_id
        AND version.first_used_at IS NOT NULL
   );

UPDATE mbt_dump_tariffs tariff
   SET item_code = COALESCE((
     SELECT item.item_code
       FROM mbt_materials material
       JOIN mbt_local_item_settings item
         ON item.item_code = material.material_code
        AND item.item_type = 'dump'
      WHERE material.material_id = tariff.material_id
      LIMIT 1
   ), 'DUMP')
 WHERE tariff.item_code IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM mbt_rate_card_versions version
      WHERE version.rate_card_version_id = tariff.rate_card_version_id
        AND version.first_used_at IS NOT NULL
   );

DROP INDEX IF EXISTS idx_mbt_rate_distance_bands_sequence;
CREATE UNIQUE INDEX idx_mbt_rate_distance_bands_sequence
  ON mbt_rate_distance_bands (
    rate_card_version_id,
    COALESCE(item_code, ''),
    service_code,
    COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    sequence_number
  );

DROP INDEX IF EXISTS idx_mbt_rate_distance_bands_minimum;
CREATE UNIQUE INDEX idx_mbt_rate_distance_bands_minimum
  ON mbt_rate_distance_bands (
    rate_card_version_id,
    COALESCE(item_code, ''),
    service_code,
    COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    minimum_metres
  );

DROP INDEX IF EXISTS idx_mbt_rate_components_scope_unique;
CREATE UNIQUE INDEX idx_mbt_rate_components_scope_unique
  ON mbt_rate_components (
    rate_card_version_id,
    COALESCE(item_code, ''),
    component_code,
    COALESCE(service_code, ''),
    COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

DROP INDEX IF EXISTS idx_mbt_dump_tariffs_scope_unique;
CREATE UNIQUE INDEX idx_mbt_dump_tariffs_scope_unique
  ON mbt_dump_tariffs (
    rate_card_version_id,
    COALESCE(item_code, ''),
    COALESCE(dump_site_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(material_id, '00000000-0000-0000-0000-000000000000'::uuid),
    tariff_code
  );

CREATE OR REPLACE FUNCTION mbt_validate_item_owned_rate_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  configured_type text;
BEGIN
  IF NEW.item_code IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT item_type INTO configured_type
    FROM mbt_local_item_settings
   WHERE item_code = NEW.item_code;

  IF TG_TABLE_NAME = 'mbt_rate_distance_bands'
     AND configured_type IS DISTINCT FROM 'delivery_fee' THEN
    RAISE EXCEPTION 'distance-band item % must have item_type=delivery_fee', NEW.item_code
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'mbt_dump_tariffs'
     AND configured_type IS DISTINCT FROM 'dump' THEN
    RAISE EXCEPTION 'dump-tariff item % must have item_type=dump', NEW.item_code
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'mbt_rate_components'
     AND COALESCE(to_jsonb(NEW)->>'component_kind', '') IN ('rental', 'extension')
     AND configured_type IS DISTINCT FROM 'bin' THEN
    RAISE EXCEPTION 'rental component item % must have item_type=bin', NEW.item_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mbt_rate_distance_bands_item
  BEFORE INSERT OR UPDATE OF item_code ON mbt_rate_distance_bands
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_item_owned_rate_reference();
CREATE TRIGGER trg_mbt_rate_components_item
  BEFORE INSERT OR UPDATE OF item_code, component_kind ON mbt_rate_components
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_item_owned_rate_reference();
CREATE TRIGGER trg_mbt_dump_tariffs_item
  BEFORE INSERT OR UPDATE OF item_code ON mbt_dump_tariffs
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_item_owned_rate_reference();

CREATE OR REPLACE FUNCTION mbt_validate_dump_site_item_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM mbt_local_item_settings
     WHERE item_code = NEW.item_code
       AND item_type = 'dump'
  ) THEN
    RAISE EXCEPTION 'dump-site item % must have item_type=dump', NEW.item_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mbt_dump_site_items_type
  BEFORE INSERT OR UPDATE OF item_code ON mbt_dump_site_items
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_dump_site_item_reference();

COMMENT ON TABLE mbt_dump_site_items IS
  'Operator-facing dump acceptance keyed by local dump item. Legacy material acceptance is maintained as a compatibility projection.';
COMMENT ON COLUMN mbt_rate_distance_bands.item_code IS
  'Local delivery-fee item that owns this customizable distance band.';
COMMENT ON COLUMN mbt_rate_components.item_code IS
  'Local item that owns this rate component; rental and extension rows point to a Bin item.';
COMMENT ON COLUMN mbt_dump_tariffs.item_code IS
  'Local dump item charged by this tariff. material_id remains a receipt compatibility key.';
