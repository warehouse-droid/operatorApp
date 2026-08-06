-- Dump-site schedules and immutable per-bin estimate evidence.
--
-- A dump site may accept many local dump items, but its weekly hours are one
-- interval per ISO weekday. Existing dump sites and contracts remain valid:
-- the new service-line evidence is nullable only for legacy rows.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE IF NOT EXISTS mbt_dump_site_opening_hours (
  opening_hour_id uuid PRIMARY KEY,
  dump_site_id uuid NOT NULL REFERENCES mbt_dump_sites(dump_site_id) ON DELETE RESTRICT,
  iso_weekday smallint NOT NULL,
  opens_at time without time zone NOT NULL,
  closes_at time without time zone NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_dump_site_opening_hours_weekday
    CHECK (iso_weekday BETWEEN 1 AND 7),
  CONSTRAINT mbt_dump_site_opening_hours_same_day
    CHECK (closes_at > opens_at),
  CONSTRAINT mbt_dump_site_opening_hours_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_dump_site_opening_hours_site_day_unique
    UNIQUE (dump_site_id, iso_weekday)
);

CREATE INDEX IF NOT EXISTS idx_mbt_dump_site_opening_hours_lookup
  ON mbt_dump_site_opening_hours (dump_site_id, iso_weekday);

ALTER TABLE mbt_contract_service_lines
  ADD COLUMN IF NOT EXISTS bin_item_code text,
  ADD COLUMN IF NOT EXISTS dump_item_code text,
  ADD COLUMN IF NOT EXISTS material_id uuid,
  ADD COLUMN IF NOT EXISTS estimated_weight_kg integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mbt_contract_service_lines_bin_item_fk'
       AND conrelid = 'mbt_contract_service_lines'::regclass
  ) THEN
    ALTER TABLE mbt_contract_service_lines
      ADD CONSTRAINT mbt_contract_service_lines_bin_item_fk
      FOREIGN KEY (bin_item_code)
      REFERENCES mbt_local_item_settings(item_code)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mbt_contract_service_lines_dump_item_fk'
       AND conrelid = 'mbt_contract_service_lines'::regclass
  ) THEN
    ALTER TABLE mbt_contract_service_lines
      ADD CONSTRAINT mbt_contract_service_lines_dump_item_fk
      FOREIGN KEY (dump_item_code)
      REFERENCES mbt_local_item_settings(item_code)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mbt_contract_service_lines_material_fk'
       AND conrelid = 'mbt_contract_service_lines'::regclass
  ) THEN
    ALTER TABLE mbt_contract_service_lines
      ADD CONSTRAINT mbt_contract_service_lines_material_fk
      FOREIGN KEY (material_id)
      REFERENCES mbt_materials(material_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mbt_contract_service_lines_dump_estimate_complete'
       AND conrelid = 'mbt_contract_service_lines'::regclass
  ) THEN
    ALTER TABLE mbt_contract_service_lines
      ADD CONSTRAINT mbt_contract_service_lines_dump_estimate_complete
      CHECK (
        (
          bin_item_code IS NULL
          AND dump_item_code IS NULL
          AND material_id IS NULL
          AND estimated_weight_kg IS NULL
        )
        OR
        (
          bin_item_code IS NOT NULL
          AND dump_item_code IS NOT NULL
          AND material_id IS NOT NULL
          AND estimated_weight_kg BETWEEN 1 AND 100000
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION mbt_validate_contract_service_line_items()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.bin_item_code IS NULL
     AND NEW.dump_item_code IS NULL
     AND NEW.material_id IS NULL
     AND NEW.estimated_weight_kg IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.bin_item_code IS NULL
     OR NEW.dump_item_code IS NULL
     OR NEW.material_id IS NULL
     OR NEW.estimated_weight_kg IS NULL
     OR NEW.estimated_weight_kg NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'physical-bin item estimate evidence is incomplete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_contract_service_lines_dump_estimate_complete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM mbt_local_item_settings item
     WHERE item.item_code = NEW.bin_item_code
       AND item.item_type = 'bin'
       AND item.bin_type_id = NEW.bin_type_id
  ) THEN
    RAISE EXCEPTION 'bin item % does not match bin type %',
      NEW.bin_item_code, NEW.bin_type_id
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM mbt_local_item_settings item
      JOIN mbt_materials material
        ON material.material_code = item.item_code
     WHERE item.item_code = NEW.dump_item_code
       AND item.item_type = 'dump'
       AND material.material_id = NEW.material_id
  ) THEN
    RAISE EXCEPTION 'dump item % does not match material %',
      NEW.dump_item_code, NEW.material_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_contract_service_line_items
  ON mbt_contract_service_lines;
CREATE TRIGGER trg_mbt_contract_service_line_items
  BEFORE INSERT OR UPDATE OF bin_type_id, bin_item_code, dump_item_code,
    material_id, estimated_weight_kg
  ON mbt_contract_service_lines
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_contract_service_line_items();

COMMENT ON TABLE mbt_dump_site_opening_hours IS
  'One local opening interval per ISO weekday for dispatch-time dump-site selection.';
COMMENT ON COLUMN mbt_contract_service_lines.estimated_weight_kg IS
  'Front Desk estimate only. Actual scale-ticket weight remains separate immutable receipt evidence.';
