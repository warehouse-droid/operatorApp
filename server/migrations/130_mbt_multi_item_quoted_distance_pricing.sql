-- MBT 2026 quoted pricing: one named rate card may contain many local items,
-- each distance series may be scoped to one or more origin yards, and quoted
-- upper boundaries remain inclusive (exactly 30 km is in Within 30 km).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Service templates remain an internal operational snapshot. Operators no
-- longer configure them directly, but quotes/contracts/visits retain their
-- immutable workflow and evidence foreign keys.
INSERT INTO mbt_service_templates (
  template_id, template_code, display_name, description, active, revision,
  created_by, updated_by
)
VALUES (
  '00000000-0000-4000-8000-000000000130',
  'MBT_INTERNAL_BIN_SERVICE',
  'Internal BIN service workflow',
  'System-owned delivery workflow used when an operator-managed rate card has no legacy template.',
  true, 1, 'migration:130', 'migration:130'
)
ON CONFLICT (template_code) DO NOTHING;

DO $$
DECLARE
  internal_template_id uuid;
BEGIN
  SELECT template_id INTO internal_template_id
    FROM mbt_service_templates
   WHERE template_code = 'MBT_INTERNAL_BIN_SERVICE';

  IF NOT EXISTS (
    SELECT 1 FROM mbt_service_template_versions
     WHERE template_version_id = '00000000-0000-4000-8000-000000000131'
  ) THEN
    INSERT INTO mbt_service_template_versions (
      template_version_id, template_id, version_number, status,
      required_bin_service, default_rental_calendar_days, billing_ownership,
      dump_site_required, revision, created_by, updated_by
    ) VALUES (
      '00000000-0000-4000-8000-000000000131', internal_template_id, 1, 'draft',
      true, 14, 'customer', false, 1, 'migration:130', 'migration:130'
    );

    INSERT INTO mbt_service_template_steps (
      template_step_id, template_version_id, sequence_number, action_code,
      display_name, stop_kind, location_role, required,
      required_asset_status_before, required_asset_status_after,
      billable_leg_to_next, dump_site_required, completion_blocking
    ) VALUES (
      '00000000-0000-4000-8000-000000000132',
      '00000000-0000-4000-8000-000000000131',
      0, 'deliver_bin', 'Deliver BIN', 'drop', 'customer_site', true,
      'on_truck', 'at_customer', false, false, true
    );

    INSERT INTO mbt_service_template_evidence_requirements (
      evidence_requirement_id, template_version_id, template_step_id,
      evidence_code, evidence_type, minimum_count, required, description
    ) VALUES (
      '00000000-0000-4000-8000-000000000133',
      '00000000-0000-4000-8000-000000000131',
      '00000000-0000-4000-8000-000000000132',
      'delivery_photo', 'photo', 1, true,
      'Required delivery evidence for the internal BIN workflow.'
    );

    UPDATE mbt_service_template_versions
       SET status = 'active', effective_from = now(), activated_at = now(),
           revision = revision + 1, updated_by = 'migration:130', updated_at = now()
     WHERE template_version_id = '00000000-0000-4000-8000-000000000131';
  END IF;
END;
$$;

UPDATE mbt_rate_cards
   SET service_template_id = (
         SELECT template_id FROM mbt_service_templates
          WHERE template_code = 'MBT_INTERNAL_BIN_SERVICE'
       ),
       revision = revision + 1,
       updated_by = 'migration:130',
       updated_at = now()
 WHERE service_template_id IS NULL;

ALTER TABLE mbt_rate_distance_bands
  ADD COLUMN IF NOT EXISTS pricing_basis text NOT NULL DEFAULT 'flat',
  ADD COLUMN IF NOT EXISTS boundary_rule text NOT NULL DEFAULT 'lower_inclusive',
  ADD COLUMN IF NOT EXISTS origin_yard_codes text[] NOT NULL DEFAULT ARRAY[]::text[];

ALTER TABLE mbt_rate_distance_bands
  DROP CONSTRAINT IF EXISTS mbt_rate_distance_bands_pricing_basis,
  DROP CONSTRAINT IF EXISTS mbt_rate_distance_bands_boundary_rule,
  DROP CONSTRAINT IF EXISTS mbt_rate_distance_bands_origin_yards;

ALTER TABLE mbt_rate_distance_bands
  ADD CONSTRAINT mbt_rate_distance_bands_pricing_basis
    CHECK (pricing_basis IN ('flat', 'per_km')),
  ADD CONSTRAINT mbt_rate_distance_bands_boundary_rule
    CHECK (boundary_rule IN ('lower_inclusive', 'upper_inclusive')),
  ADD CONSTRAINT mbt_rate_distance_bands_origin_yards
    CHECK (
      array_position(origin_yard_codes, NULL) IS NULL
      AND (
        cardinality(origin_yard_codes) = 0
        OR array_to_string(origin_yard_codes, ',') !~ '(^|,)[[:space:]]*(,|$)'
      )
    );

DROP INDEX IF EXISTS idx_mbt_rate_distance_bands_sequence;
DROP INDEX IF EXISTS idx_mbt_rate_distance_bands_minimum;
CREATE UNIQUE INDEX idx_mbt_rate_distance_bands_sequence
  ON mbt_rate_distance_bands (
    rate_card_version_id,
    COALESCE(item_code, ''),
    service_code,
    COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    origin_yard_codes,
    sequence_number
  );
CREATE UNIQUE INDEX idx_mbt_rate_distance_bands_minimum
  ON mbt_rate_distance_bands (
    rate_card_version_id,
    COALESCE(item_code, ''),
    service_code,
    COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    origin_yard_codes,
    minimum_metres
  );

-- Migration 128 temporarily constrained new rate cards to one unique item.
-- The supplied 2026 price sheet is intentionally one rate card to multiple
-- local items and pricing series, so child rows are the pricing ownership.
DROP INDEX IF EXISTS idx_mbt_rate_cards_item_unique;
DROP TRIGGER IF EXISTS trg_mbt_rate_distance_bands_owner_item ON mbt_rate_distance_bands;
DROP TRIGGER IF EXISTS trg_mbt_rate_components_owner_item ON mbt_rate_components;
DROP TRIGGER IF EXISTS trg_mbt_dump_tariffs_owner_item ON mbt_dump_tariffs;
DROP TRIGGER IF EXISTS trg_mbt_rate_cards_item_identity ON mbt_rate_cards;

UPDATE mbt_rate_cards
   SET item_code = NULL,
       revision = revision + 1,
       updated_by = 'migration:130',
       updated_at = now()
 WHERE item_code IS NOT NULL;

COMMENT ON COLUMN mbt_rate_cards.item_code IS
  'Deprecated single-item compatibility field. New and migrated rate cards contain multiple local items through their child pricing rows.';
COMMENT ON COLUMN mbt_rate_distance_bands.pricing_basis IS
  'flat means amount_minor is the complete band charge; per_km means cents per actual unrounded kilometre.';
COMMENT ON COLUMN mbt_rate_distance_bands.boundary_rule IS
  'upper_inclusive keeps exact quoted maxima such as 30.000 km in the preceding band; lower_inclusive preserves legacy [min,max) evidence.';
COMMENT ON COLUMN mbt_rate_distance_bands.origin_yard_codes IS
  'Sorted active MBT yard codes for this series; an empty array applies to every origin yard.';

-- Correct the explicit operator-reported MBBS draft: exact quoted upper
-- boundaries belong to the preceding band and over 75 km is CAD 7 per km.
UPDATE mbt_rate_distance_bands band
   SET boundary_rule = 'upper_inclusive'
  FROM mbt_rate_card_versions version
  JOIN mbt_rate_cards card USING (rate_card_id)
 WHERE band.rate_card_version_id = version.rate_card_version_id
   AND card.rate_card_code = 'DELIVERY_CHARGE_MBBS'
   AND card.display_name = 'Delivery_Charge_MBBS_2026_Rate'
   AND version.status = 'draft'
   AND version.first_used_at IS NULL;

UPDATE mbt_rate_distance_bands band
   SET pricing_basis = 'per_km',
       amount_minor = 700,
       description = 'Over 75 km · CAD 7.00 per actual kilometre'
  FROM mbt_rate_card_versions version
  JOIN mbt_rate_cards card USING (rate_card_id)
 WHERE band.rate_card_version_id = version.rate_card_version_id
   AND card.rate_card_code = 'DELIVERY_CHARGE_MBBS'
   AND card.display_name = 'Delivery_Charge_MBBS_2026_Rate'
   AND version.status = 'draft'
   AND version.first_used_at IS NULL
   AND band.minimum_metres = 75000
   AND band.maximum_metres IS NULL;

CREATE OR REPLACE FUNCTION mbt_validate_rate_card_version_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  configured_count integer;
  invalid_count integer;
BEGIN
  IF NEW.status <> 'active'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN
    RETURN NEW;
  END IF;

  SELECT (
           (SELECT count(*) FROM mbt_rate_distance_bands WHERE rate_card_version_id = NEW.rate_card_version_id)
           + (SELECT count(*) FROM mbt_rate_components WHERE rate_card_version_id = NEW.rate_card_version_id AND active)
           + (SELECT count(*) FROM mbt_dump_tariffs WHERE rate_card_version_id = NEW.rate_card_version_id AND active)
         )::integer
    INTO configured_count;

  WITH ordered_bands AS (
    SELECT minimum_metres,
           maximum_metres,
           row_number() OVER (
             PARTITION BY COALESCE(item_code, ''), service_code,
                          COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          origin_yard_codes
             ORDER BY minimum_metres, sequence_number, rate_distance_band_id
           ) AS band_position,
           count(*) OVER (
             PARTITION BY COALESCE(item_code, ''), service_code,
                          COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          origin_yard_codes
           ) AS group_size,
           lag(maximum_metres) OVER (
             PARTITION BY COALESCE(item_code, ''), service_code,
                          COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
                          origin_yard_codes
             ORDER BY minimum_metres, sequence_number, rate_distance_band_id
           ) AS previous_maximum
      FROM mbt_rate_distance_bands
     WHERE rate_card_version_id = NEW.rate_card_version_id
  ), invalid_bin_items AS (
    SELECT component.item_code
      FROM mbt_rate_components component
      JOIN mbt_local_item_settings item ON item.item_code = component.item_code
     WHERE component.rate_card_version_id = NEW.rate_card_version_id
       AND component.active
       AND item.item_type = 'bin'
     GROUP BY component.item_code
    HAVING count(DISTINCT component.component_kind)
             FILTER (WHERE component.component_kind IN ('rental', 'extension')) <> 2
  ), invalid_dump_items AS (
    SELECT item.item_code
      FROM mbt_local_item_settings item
     WHERE item.item_type = 'dump'
       AND EXISTS (
         SELECT 1 FROM mbt_dump_tariffs tariff
          WHERE tariff.rate_card_version_id = NEW.rate_card_version_id
            AND tariff.item_code = item.item_code
       )
       AND NOT EXISTS (
         SELECT 1 FROM mbt_dump_tariffs tariff
          WHERE tariff.rate_card_version_id = NEW.rate_card_version_id
            AND tariff.item_code = item.item_code
            AND tariff.active
       )
  )
  SELECT (
      count(*) FILTER (
        WHERE (band_position = 1 AND minimum_metres <> 0)
           OR (band_position > 1 AND previous_maximum IS DISTINCT FROM minimum_metres)
           OR (band_position < group_size AND maximum_metres IS NULL)
           OR (band_position = group_size AND maximum_metres IS NOT NULL)
      )
      + (SELECT count(*) FROM invalid_bin_items)
      + (SELECT count(*) FROM invalid_dump_items)
    )::integer
    INTO invalid_count
    FROM ordered_bands;

  IF configured_count = 0 OR COALESCE(invalid_count, 0) > 0 THEN
    RAISE EXCEPTION 'rate-card version % has invalid multi-item pricing', NEW.rate_card_version_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_rate_card_versions_item_pricing_valid';
  END IF;
  RETURN NEW;
END;
$$;
