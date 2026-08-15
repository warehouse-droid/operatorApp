BEGIN;

-- MBBS cross-charge arithmetic belongs to the selected effective-dated rate
-- card. The rule identifiers are fixed for schema version 1; the two unit
-- prices are editable on unused drafts and snapshotted into billing evidence.
CREATE TABLE IF NOT EXISTS mbt_mbbs_rate_card_policies (
  rate_card_version_id uuid PRIMARY KEY
    REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  schema_version integer NOT NULL DEFAULT 1,
  currency text NOT NULL DEFAULT 'CAD',
  direct_pickup_unit_amount_minor bigint NOT NULL DEFAULT 10000,
  po_additional_drop_unit_amount_minor bigint NOT NULL DEFAULT 10000,
  so_charge_basis text NOT NULL DEFAULT 'per_order_group_as_one',
  to_replenishment_charge_basis text NOT NULL DEFAULT 'full_route_once',
  to_direct_pickup_charge_basis text NOT NULL DEFAULT 'fixed_unit_once',
  po_charge_basis text NOT NULL DEFAULT 'shared_leg_equal_split',
  po_additional_drop_basis text NOT NULL DEFAULT 'each_distinct_drop_after_first',
  dispatch_load_split_basis text NOT NULL DEFAULT 'ignored_for_charge',
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_mbbs_rate_card_policy_schema_v1 CHECK (schema_version = 1),
  CONSTRAINT mbt_mbbs_rate_card_policy_currency_cad CHECK (currency = 'CAD'),
  CONSTRAINT mbt_mbbs_rate_card_policy_direct_pickup_nonnegative
    CHECK (direct_pickup_unit_amount_minor >= 0),
  CONSTRAINT mbt_mbbs_rate_card_policy_po_drop_nonnegative
    CHECK (po_additional_drop_unit_amount_minor >= 0),
  CONSTRAINT mbt_mbbs_rate_card_policy_so_v1
    CHECK (so_charge_basis = 'per_order_group_as_one'),
  CONSTRAINT mbt_mbbs_rate_card_policy_to_replenishment_v1
    CHECK (to_replenishment_charge_basis = 'full_route_once'),
  CONSTRAINT mbt_mbbs_rate_card_policy_to_direct_v1
    CHECK (to_direct_pickup_charge_basis = 'fixed_unit_once'),
  CONSTRAINT mbt_mbbs_rate_card_policy_po_v1
    CHECK (po_charge_basis = 'shared_leg_equal_split'),
  CONSTRAINT mbt_mbbs_rate_card_policy_po_drop_v1
    CHECK (po_additional_drop_basis = 'each_distinct_drop_after_first'),
  CONSTRAINT mbt_mbbs_rate_card_policy_load_split_v1
    CHECK (dispatch_load_split_basis = 'ignored_for_charge'),
  CONSTRAINT mbt_mbbs_rate_card_policy_revision_positive CHECK (revision > 0)
);

INSERT INTO mbt_mbbs_rate_card_policies (rate_card_version_id)
SELECT DISTINCT band.rate_card_version_id
  FROM mbt_rate_distance_bands band
 WHERE band.item_code = 'DELIVERY_CHARGE_MBBS'
   AND band.service_code = 'mbbs_cross_charge'
ON CONFLICT (rate_card_version_id) DO NOTHING;

-- Low-level fixtures and import paths that add an MBBS band receive an
-- explicit policy row immediately. Runtime calculation never falls back to a
-- constant: it always reads this version-owned row.
CREATE OR REPLACE FUNCTION mbt_provision_mbbs_rate_card_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.item_code = 'DELIVERY_CHARGE_MBBS'
     AND NEW.service_code = 'mbbs_cross_charge' THEN
    INSERT INTO mbt_mbbs_rate_card_policies (rate_card_version_id)
    VALUES (NEW.rate_card_version_id)
    ON CONFLICT (rate_card_version_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_provision_mbbs_rate_card_policy
  ON mbt_rate_distance_bands;
CREATE TRIGGER trg_mbt_provision_mbbs_rate_card_policy
  AFTER INSERT OR UPDATE OF rate_card_version_id, item_code, service_code
  ON mbt_rate_distance_bands
  FOR EACH ROW EXECUTE FUNCTION mbt_provision_mbbs_rate_card_policy();

CREATE OR REPLACE FUNCTION mbt_reject_immutable_mbbs_rate_card_policy()
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
    RAISE EXCEPTION 'MBBS charging policy for non-draft rate-card version % is immutable', retained_version_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_mbbs_rate_card_policy_immutable
  ON mbt_mbbs_rate_card_policies;
CREATE TRIGGER trg_mbt_mbbs_rate_card_policy_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON mbt_mbbs_rate_card_policies
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mbbs_rate_card_policy();

CREATE OR REPLACE FUNCTION mbt_validate_mbbs_rate_card_policy_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'active')
     AND EXISTS (
       SELECT 1
         FROM mbt_rate_distance_bands band
        WHERE band.rate_card_version_id = NEW.rate_card_version_id
          AND band.item_code = 'DELIVERY_CHARGE_MBBS'
          AND band.service_code = 'mbbs_cross_charge'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM mbt_mbbs_rate_card_policies policy
        WHERE policy.rate_card_version_id = NEW.rate_card_version_id
     ) THEN
    RAISE EXCEPTION 'MBBS rate-card version % has no charging policy', NEW.rate_card_version_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_rate_card_versions_mbbs_policy_required';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_rate_card_versions_mbbs_policy_valid
  ON mbt_rate_card_versions;
CREATE TRIGGER trg_mbt_rate_card_versions_mbbs_policy_valid
  BEFORE INSERT OR UPDATE OF status ON mbt_rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_mbbs_rate_card_policy_activation();

COMMENT ON TABLE mbt_mbbs_rate_card_policies IS
  'Version-owned MBBS SO/TO/PO charging policy. Prices change through rate-card cloning and effective dating.';
COMMENT ON COLUMN mbt_mbbs_rate_card_policies.direct_pickup_unit_amount_minor IS
  'Fixed CAD cents charged once for a completed direct-pickup/drop-ship TO.';
COMMENT ON COLUMN mbt_mbbs_rate_card_policies.po_additional_drop_unit_amount_minor IS
  'CAD cents charged for each distinct PO drop after the first drop on one business leg.';

COMMIT;
