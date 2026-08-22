BEGIN;

SET LOCAL lock_timeout = '3s';

-- Policy schema v1 remains byte-for-byte meaningful for historical rate-card
-- versions. Schema v2 adds the approved PO/VRMA vendor-pair mechanism without
-- silently changing any existing version.
ALTER TABLE mbt_mbbs_rate_card_policies
  ADD COLUMN IF NOT EXISTS po_vrma_additional_stop_unit_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS po_vrma_base_charge_basis text,
  ADD COLUMN IF NOT EXISTS vrma_direction_basis text,
  ADD COLUMN IF NOT EXISTS po_vrma_additional_stop_basis text,
  ADD COLUMN IF NOT EXISTS endpoint_override_basis text;

ALTER TABLE mbt_mbbs_rate_card_policies
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_schema_v1,
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_schema_supported,
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_v2_fields,
  DROP CONSTRAINT IF EXISTS mbt_mbbs_rate_card_policy_v2_stop_nonnegative;

ALTER TABLE mbt_mbbs_rate_card_policies
  ADD CONSTRAINT mbt_mbbs_rate_card_policy_schema_supported
    CHECK (schema_version IN (1, 2)),
  ADD CONSTRAINT mbt_mbbs_rate_card_policy_v2_stop_nonnegative
    CHECK (po_vrma_additional_stop_unit_amount_minor IS NULL
           OR po_vrma_additional_stop_unit_amount_minor >= 0),
  ADD CONSTRAINT mbt_mbbs_rate_card_policy_v2_fields CHECK (
    (schema_version = 1
      AND po_vrma_additional_stop_unit_amount_minor IS NULL
      AND po_vrma_base_charge_basis IS NULL
      AND vrma_direction_basis IS NULL
      AND po_vrma_additional_stop_basis IS NULL
      AND endpoint_override_basis IS NULL)
    OR
    (schema_version = 2
      AND po_vrma_additional_stop_unit_amount_minor IS NOT NULL
      AND po_vrma_base_charge_basis = 'vendor_yard_pair_then_distance_band'
      AND vrma_direction_basis = 'same_pair_reverse'
      AND po_vrma_additional_stop_basis = 'each_distinct_stop_after_base_pair'
      AND endpoint_override_basis = 'flat_default_user_may_choose_distance')
  );

CREATE TABLE IF NOT EXISTS mbt_mbbs_vendor_route_rates (
  vendor_route_rate_id uuid PRIMARY KEY,
  rate_card_version_id uuid NOT NULL
    REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  rate_name text NOT NULL,
  display_name text NOT NULL,
  local_vendor_id bigint NOT NULL
    REFERENCES dispatch_local_vendors(id) ON DELETE RESTRICT,
  vendor_yard_name text NOT NULL,
  vendor_yard_address text NOT NULL,
  destination_yard_id uuid NOT NULL
    REFERENCES mbt_yards(yard_id) ON DELETE RESTRICT,
  base_amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_mbbs_vendor_route_rate_name_not_blank
    CHECK (NULLIF(btrim(rate_name), '') IS NOT NULL),
  CONSTRAINT mbt_mbbs_vendor_route_display_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_mbbs_vendor_route_yard_not_blank
    CHECK (NULLIF(btrim(vendor_yard_name), '') IS NOT NULL),
  CONSTRAINT mbt_mbbs_vendor_route_address_not_blank
    CHECK (NULLIF(btrim(vendor_yard_address), '') IS NOT NULL),
  CONSTRAINT mbt_mbbs_vendor_route_rate_amount_nonnegative
    CHECK (base_amount_minor >= 0),
  CONSTRAINT mbt_mbbs_vendor_route_rate_currency_cad
    CHECK (currency = 'CAD'),
  CONSTRAINT mbt_mbbs_vendor_route_rate_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_mbbs_vendor_route_rate_pair_unique
    UNIQUE (rate_card_version_id, local_vendor_id, vendor_yard_name, destination_yard_id),
  CONSTRAINT mbt_mbbs_vendor_route_rate_name_unique
    UNIQUE (rate_card_version_id, rate_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_mbbs_vendor_route_pair_ci
  ON mbt_mbbs_vendor_route_rates (
    rate_card_version_id,
    local_vendor_id,
    lower(btrim(vendor_yard_name)),
    destination_yard_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_mbbs_vendor_route_name_ci
  ON mbt_mbbs_vendor_route_rates (rate_card_version_id, lower(btrim(rate_name)));

CREATE OR REPLACE FUNCTION mbt_reject_immutable_mbbs_vendor_route_rate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retained_version_id uuid;
  retained_status text;
  retained_first_used_at timestamptz;
BEGIN
  retained_version_id := CASE WHEN TG_OP = 'INSERT'
    THEN NEW.rate_card_version_id ELSE OLD.rate_card_version_id END;
  SELECT status, first_used_at
    INTO retained_status, retained_first_used_at
    FROM mbt_rate_card_versions
   WHERE rate_card_version_id = retained_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rate-card version % was not found', retained_version_id
      USING ERRCODE = '23503';
  END IF;
  IF retained_status <> 'draft' OR retained_first_used_at IS NOT NULL THEN
    RAISE EXCEPTION 'MBBS vendor-route rates for non-draft rate-card version % are immutable', retained_version_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_mbbs_vendor_route_rate_immutable
  ON mbt_mbbs_vendor_route_rates;
CREATE TRIGGER trg_mbt_mbbs_vendor_route_rate_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbt_mbbs_vendor_route_rates
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mbbs_vendor_route_rate();

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
          AND policy.schema_version = 2
     ) THEN
    RAISE EXCEPTION 'MBBS vendor-route rates require policy schema version 2 for rate-card version %', NEW.rate_card_version_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_rate_card_versions_mbbs_vendor_policy_v2';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_rate_card_versions_mbbs_vendor_rates_valid
  ON mbt_rate_card_versions;
CREATE TRIGGER trg_mbt_rate_card_versions_mbbs_vendor_rates_valid
  BEFORE INSERT OR UPDATE OF status ON mbt_rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_mbbs_vendor_route_rate_activation();

COMMENT ON TABLE mbt_mbbs_vendor_route_rates IS
  'Effective-dated CAD base prices for one physical vendor-yard/MBBS-yard pair; PO and reverse VRMA share the same row.';
COMMENT ON COLUMN mbt_mbbs_vendor_route_rates.vendor_yard_name IS
  'Server-validated local physical-yard name snapshot. Weekday schedule rows are deliberately collapsed.';
COMMENT ON COLUMN mbt_mbbs_vendor_route_rates.vendor_yard_address IS
  'Vendor-yard address snapshot used for visible evidence and endpoint-override detection.';

COMMIT;
