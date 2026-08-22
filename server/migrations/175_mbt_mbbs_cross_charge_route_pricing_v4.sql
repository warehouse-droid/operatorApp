BEGIN;

SET LOCAL lock_timeout = '3s';

-- A distance band can now state a fixed amount covering an included distance,
-- followed by its existing per-kilometre amount. Historical per_km rows keep
-- their full-distance meaning because both new columns remain NULL.
ALTER TABLE mbt_rate_distance_bands
  ADD COLUMN IF NOT EXISTS base_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS included_metres bigint;

ALTER TABLE mbt_rate_distance_bands
  DROP CONSTRAINT IF EXISTS mbt_rate_distance_bands_base_excess_shape,
  DROP CONSTRAINT IF EXISTS mbt_rate_distance_bands_base_excess_nonnegative;

ALTER TABLE mbt_rate_distance_bands
  ADD CONSTRAINT mbt_rate_distance_bands_base_excess_shape CHECK (
    (base_amount_minor IS NULL AND included_metres IS NULL)
    OR
    (base_amount_minor IS NOT NULL
      AND included_metres IS NOT NULL
      AND pricing_basis = 'per_km')
  ),
  ADD CONSTRAINT mbt_rate_distance_bands_base_excess_nonnegative CHECK (
    (base_amount_minor IS NULL OR base_amount_minor >= 0)
    AND (included_metres IS NULL OR included_metres >= 0)
  );

COMMENT ON COLUMN mbt_rate_distance_bands.base_amount_minor IS
  'Optional fixed cents included before a per-km excess charge; paired with included_metres.';
COMMENT ON COLUMN mbt_rate_distance_bands.included_metres IS
  'Optional distance included in base_amount_minor; only metres above it receive amount_minor per km.';

-- Existing rows contained only a destination correction. Retain those rows,
-- and allow every subsequent save to own an explicit billing-only endpoint
-- pair without rewriting operational evidence.
ALTER TABLE mbt_mbbs_billing_address_overrides
  ADD COLUMN IF NOT EXISTS origin_address_text text;

ALTER TABLE mbt_mbbs_billing_address_overrides
  DROP CONSTRAINT IF EXISTS mbt_mbbs_billing_origin_text_valid;

ALTER TABLE mbt_mbbs_billing_address_overrides
  ADD CONSTRAINT mbt_mbbs_billing_origin_text_valid CHECK (
    origin_address_text IS NULL
    OR (
      NULLIF(btrim(origin_address_text), '') IS NOT NULL
      AND length(origin_address_text) <= 1000
    )
  );

COMMENT ON COLUMN mbt_mbbs_billing_address_overrides.origin_address_text IS
  'Audited local billing origin; NULL only on destination-only rows created before v4.';

-- Policy schema v3 makes the TO longest-drop rule and its price visible and
-- effective-dated. Older policy snapshots remain byte-for-byte meaningful.
ALTER TABLE mbt_mbbs_rate_card_policies
  ADD COLUMN IF NOT EXISTS to_replenishment_additional_drop_unit_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS to_replenishment_multi_drop_basis text;

ALTER TABLE mbt_mbbs_rate_card_policies
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_schema_supported,
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_v2_fields,
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_v3_fields,
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_v3_to_drop_nonnegative;

ALTER TABLE mbt_mbbs_rate_card_policies
  ADD CONSTRAINT mbt_mbbs_rate_card_policy_schema_supported
    CHECK (schema_version IN (1, 2, 3)),
  ADD CONSTRAINT mbt_mbbs_rate_card_policy_v3_to_drop_nonnegative
    CHECK (to_replenishment_additional_drop_unit_amount_minor IS NULL
           OR to_replenishment_additional_drop_unit_amount_minor >= 0),
  ADD CONSTRAINT mbt_mbbs_rate_card_policy_v3_fields CHECK (
    (schema_version = 1
      AND po_vrma_additional_stop_unit_amount_minor IS NULL
      AND po_vrma_base_charge_basis IS NULL
      AND vrma_direction_basis IS NULL
      AND po_vrma_additional_stop_basis IS NULL
      AND endpoint_override_basis IS NULL
      AND to_replenishment_additional_drop_unit_amount_minor IS NULL
      AND to_replenishment_multi_drop_basis IS NULL)
    OR
    (schema_version = 2
      AND po_vrma_additional_stop_unit_amount_minor IS NOT NULL
      AND po_vrma_base_charge_basis = 'vendor_yard_pair_then_distance_band'
      AND vrma_direction_basis = 'same_pair_reverse'
      AND po_vrma_additional_stop_basis = 'each_distinct_stop_after_base_pair'
      AND endpoint_override_basis = 'flat_default_user_may_choose_distance'
      AND to_replenishment_additional_drop_unit_amount_minor IS NULL
      AND to_replenishment_multi_drop_basis IS NULL)
    OR
    (schema_version = 3
      AND po_vrma_additional_stop_unit_amount_minor IS NOT NULL
      AND po_vrma_base_charge_basis = 'vendor_yard_pair_then_distance_band'
      AND vrma_direction_basis = 'same_pair_reverse'
      AND po_vrma_additional_stop_basis = 'each_distinct_stop_after_base_pair'
      AND endpoint_override_basis = 'flat_default_user_may_choose_distance'
      AND to_replenishment_additional_drop_unit_amount_minor IS NOT NULL
      AND to_replenishment_multi_drop_basis =
        'longest_origin_drop_plus_each_distinct_drop_after_first')
  );

-- The v2 activation trigger deliberately required schema 2. Vendor-pair
-- pricing is unchanged in schema 3, so permit either evidence shape.
CREATE OR REPLACE FUNCTION mbt_validate_mbbs_vendor_route_rate_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'active')
     AND EXISTS (
       SELECT 1
         FROM mbt_mbbs_vendor_route_rates route_rate
        WHERE route_rate.rate_card_version_id = NEW.rate_card_version_id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM mbt_mbbs_rate_card_policies policy
        WHERE policy.rate_card_version_id = NEW.rate_card_version_id
          AND policy.schema_version IN (2, 3)
     ) THEN
    RAISE EXCEPTION 'MBBS vendor-route rates require policy schema version 2 or 3 for rate-card version %', NEW.rate_card_version_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_rate_card_versions_mbbs_vendor_policy_v2';
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve the immutable active v3 graph and create one corrected v4 graph.
-- Converted v3 billing evidence remains untouched; new calculations use v4.
DO $$
DECLARE
  retained_card_id uuid;
  source_version_id uuid;
  corrected_version_id uuid;
  cutover_at timestamptz := transaction_timestamp();
BEGIN
  SELECT card.rate_card_id, version.rate_card_version_id
    INTO retained_card_id, source_version_id
    FROM mbt_rate_cards card
    JOIN mbt_rate_card_versions version USING (rate_card_id)
   WHERE card.rate_card_code = 'DELIVERY_CHARGE_MBBS'
     AND card.display_name = 'Delivery_Charge_MBBS_2026_Rate'
     AND version.version_number = 3
     AND version.status = 'active'
   FOR UPDATE OF card, version;

  IF source_version_id IS NULL OR EXISTS (
    SELECT 1
      FROM mbt_rate_card_versions version
     WHERE version.rate_card_id = retained_card_id
       AND version.version_number = 4
  ) THEN
    RETURN;
  END IF;

  corrected_version_id := gen_random_uuid();
  INSERT INTO mbt_rate_card_versions (
    rate_card_version_id, rate_card_id, version_number, status,
    effective_from, effective_to, default_rental_calendar_days,
    calculation_notes, validation_snapshot, revision,
    created_by, updated_by, created_at, updated_at
  )
  SELECT corrected_version_id, rate_card_id, 4, 'draft',
         effective_from, NULL, default_rental_calendar_days,
         'MBBS v4: exact CAD 285 30-50 km; CAD 385 first 75 km plus CAD 7/km excess; TO longest-drop billing.',
         jsonb_build_object(
           'valid', true,
           'source', 'migration:175',
           'replacesRateCardVersionId', source_version_id::text
         ),
         1, 'migration:175', 'migration:175', cutover_at, cutover_at
    FROM mbt_rate_card_versions
   WHERE rate_card_version_id = source_version_id;

  INSERT INTO mbt_mbbs_rate_card_policies (
    rate_card_version_id, schema_version, currency,
    direct_pickup_unit_amount_minor, po_additional_drop_unit_amount_minor,
    so_charge_basis, to_replenishment_charge_basis,
    to_direct_pickup_charge_basis, po_charge_basis,
    po_additional_drop_basis, dispatch_load_split_basis,
    po_vrma_additional_stop_unit_amount_minor,
    po_vrma_base_charge_basis, vrma_direction_basis,
    po_vrma_additional_stop_basis, endpoint_override_basis,
    to_replenishment_additional_drop_unit_amount_minor,
    to_replenishment_multi_drop_basis,
    revision, created_by, updated_by, created_at, updated_at
  )
  SELECT corrected_version_id, 3, currency,
         direct_pickup_unit_amount_minor, po_additional_drop_unit_amount_minor,
         so_charge_basis, to_replenishment_charge_basis,
         to_direct_pickup_charge_basis, po_charge_basis,
         po_additional_drop_basis, dispatch_load_split_basis,
         COALESCE(po_vrma_additional_stop_unit_amount_minor,
                  po_additional_drop_unit_amount_minor),
         'vendor_yard_pair_then_distance_band', 'same_pair_reverse',
         'each_distinct_stop_after_base_pair',
         'flat_default_user_may_choose_distance',
         10000,
         'longest_origin_drop_plus_each_distinct_drop_after_first',
         1, 'migration:175', 'migration:175', cutover_at, cutover_at
    FROM mbt_mbbs_rate_card_policies
   WHERE rate_card_version_id = source_version_id;

  INSERT INTO mbt_rate_distance_bands (
    rate_distance_band_id, rate_card_version_id, item_code, service_code,
    bin_type_id, sequence_number, minimum_metres, maximum_metres,
    amount_minor, pricing_basis, boundary_rule, origin_yard_codes,
    currency, downtown_surcharge_minor, description,
    base_amount_minor, included_metres, created_at
  )
  SELECT gen_random_uuid(), corrected_version_id, item_code, service_code,
         bin_type_id, sequence_number, minimum_metres, maximum_metres,
         CASE
           WHEN item_code = 'DELIVERY_CHARGE_MBBS'
            AND service_code = 'mbbs_cross_charge'
            AND minimum_metres = 30000 AND maximum_metres = 50000
             THEN 28500
           ELSE amount_minor
         END,
         pricing_basis, boundary_rule, origin_yard_codes,
         currency, downtown_surcharge_minor,
         CASE
           WHEN item_code = 'DELIVERY_CHARGE_MBBS'
            AND service_code = 'mbbs_cross_charge'
            AND minimum_metres = 30000 AND maximum_metres = 50000
             THEN 'Over 30 km to 50 km · flat CAD 285.00'
           WHEN item_code = 'DELIVERY_CHARGE_MBBS'
            AND service_code = 'mbbs_cross_charge'
            AND minimum_metres = 75000 AND maximum_metres IS NULL
             THEN 'Over 75 km · CAD 385.00 includes 75 km, then CAD 7.00 per excess kilometre'
           ELSE description
         END,
         CASE
           WHEN item_code = 'DELIVERY_CHARGE_MBBS'
            AND service_code = 'mbbs_cross_charge'
            AND minimum_metres = 75000 AND maximum_metres IS NULL
             THEN 38500
           ELSE base_amount_minor
         END,
         CASE
           WHEN item_code = 'DELIVERY_CHARGE_MBBS'
            AND service_code = 'mbbs_cross_charge'
            AND minimum_metres = 75000 AND maximum_metres IS NULL
             THEN 75000
           ELSE included_metres
         END,
         cutover_at
    FROM mbt_rate_distance_bands
   WHERE rate_card_version_id = source_version_id;

  INSERT INTO mbt_rate_components (
    rate_component_id, rate_card_version_id, item_code, component_code,
    component_kind, service_code, bin_type_id, rate_basis, amount_minor,
    percentage_basis_points, default_quantity, currency, taxable, active,
    description, created_at
  )
  SELECT gen_random_uuid(), corrected_version_id, item_code, component_code,
         component_kind, service_code, bin_type_id, rate_basis, amount_minor,
         percentage_basis_points, default_quantity, currency, taxable, active,
         description, cutover_at
    FROM mbt_rate_components
   WHERE rate_card_version_id = source_version_id;

  INSERT INTO mbt_dump_tariffs (
    dump_tariff_id, rate_card_version_id, item_code, dump_site_id,
    material_id, tariff_code, pricing_basis, unit_of_measure, amount_minor,
    minimum_amount_minor, currency, active, description, created_at
  )
  SELECT gen_random_uuid(), corrected_version_id, item_code, dump_site_id,
         material_id, tariff_code, pricing_basis, unit_of_measure, amount_minor,
         minimum_amount_minor, currency, active, description, cutover_at
    FROM mbt_dump_tariffs
   WHERE rate_card_version_id = source_version_id;

  INSERT INTO mbt_deposit_rules (
    deposit_rule_id, rate_card_version_id, rule_code, rule_type, bin_type_id,
    service_code, fixed_amount_minor, percentage_basis_points, currency,
    liability_account_mapping_key, active, description, created_at
  )
  SELECT gen_random_uuid(), corrected_version_id, rule_code, rule_type,
         bin_type_id, service_code, fixed_amount_minor,
         percentage_basis_points, currency, liability_account_mapping_key,
         active, description, cutover_at
    FROM mbt_deposit_rules
   WHERE rate_card_version_id = source_version_id;

  INSERT INTO mbt_mbbs_vendor_route_rates (
    vendor_route_rate_id, rate_card_version_id, rate_name, display_name,
    local_vendor_id, vendor_yard_name, vendor_yard_address,
    destination_yard_id, base_amount_minor, currency, revision,
    created_by, updated_by, created_at, updated_at
  )
  SELECT gen_random_uuid(), corrected_version_id, rate_name, display_name,
         local_vendor_id, vendor_yard_name, vendor_yard_address,
         destination_yard_id, base_amount_minor, currency, 1,
         'migration:175', 'migration:175', cutover_at, cutover_at
    FROM mbt_mbbs_vendor_route_rates
   WHERE rate_card_version_id = source_version_id;

  UPDATE mbt_rate_card_versions
     SET status = 'retired',
         effective_to = CASE
           WHEN effective_from IS NULL OR effective_from >= cutover_at THEN effective_to
           WHEN effective_to IS NULL OR effective_to > cutover_at THEN cutover_at
           ELSE effective_to
         END,
         retired_at = cutover_at,
         revision = revision + 1,
         updated_by = 'migration:175',
         updated_at = cutover_at
   WHERE rate_card_version_id = source_version_id
     AND status = 'active';

  UPDATE mbt_rate_card_versions
     SET status = 'active',
         activated_at = cutover_at,
         revision = revision + 1,
         updated_by = 'migration:175',
         updated_at = cutover_at
   WHERE rate_card_version_id = corrected_version_id
     AND status = 'draft';
END;
$$;

COMMIT;
