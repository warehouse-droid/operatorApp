-- MBT Front Desk customer-charge requests, payment-specific HST evidence,
-- aggregate material rates, and future NetSuite-safe export snapshots.

CREATE TABLE IF NOT EXISTS mbt_frontdesk_charge_catalog (
  item_code text PRIMARY KEY,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  item_kind text NOT NULL,
  content_code text,
  unit_of_measure text NOT NULL,
  default_amount_minor bigint,
  density_lbs_per_yard integer,
  netsuite_mapping_local_key text,
  active boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL DEFAULT 'migration:142',
  updated_by text NOT NULL DEFAULT 'migration:142',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_frontdesk_charge_catalog_code_format
    CHECK (item_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  CONSTRAINT mbt_frontdesk_charge_catalog_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT mbt_frontdesk_charge_catalog_kind
    CHECK (item_kind IN ('fixed_dump', 'aggregate_material', 'loading_fee')),
  CONSTRAINT mbt_frontdesk_charge_catalog_uom
    CHECK (unit_of_measure IN ('BIN', 'YARD', 'VISIT')),
  CONSTRAINT mbt_frontdesk_charge_catalog_amount_nonnegative
    CHECK (default_amount_minor IS NULL OR default_amount_minor >= 0),
  CONSTRAINT mbt_frontdesk_charge_catalog_density_positive
    CHECK (density_lbs_per_yard IS NULL OR density_lbs_per_yard > 0),
  CONSTRAINT mbt_frontdesk_charge_catalog_shape
    CHECK (
      (
        item_kind = 'fixed_dump'
        AND content_code IN ('soil', 'asphalt', 'concrete')
        AND unit_of_measure = 'BIN'
        AND density_lbs_per_yard IS NULL
      )
      OR (
        item_kind = 'aggregate_material'
        AND content_code IS NULL
        AND unit_of_measure = 'YARD'
        AND default_amount_minor IS NULL
      )
      OR (
        item_kind = 'loading_fee'
        AND content_code IS NULL
        AND unit_of_measure = 'VISIT'
        AND default_amount_minor IS NOT NULL
        AND density_lbs_per_yard IS NULL
      )
    ),
  CONSTRAINT mbt_frontdesk_charge_catalog_revision_positive CHECK (revision > 0),
  CONSTRAINT mbt_frontdesk_charge_catalog_content_unique UNIQUE (item_kind, content_code)
);

INSERT INTO mbt_frontdesk_charge_catalog (
  item_code, display_name, description, item_kind, content_code,
  unit_of_measure, default_amount_minor, density_lbs_per_yard,
  netsuite_mapping_local_key, active
) VALUES
  ('AGG_CLEAR_LIMESTONE_34', '3/4 Clear Limestone', 'Aggregate material priced independently in MBT per yard.', 'aggregate_material', NULL, 'YARD', NULL, NULL, 'aggregate.clear_limestone_34', false),
  ('AGG_CRUSHER_RUN', 'Crusher Run', 'Aggregate material priced independently in MBT per yard.', 'aggregate_material', NULL, 'YARD', NULL, NULL, 'aggregate.crusher_run', false),
  ('AGG_HPB', 'HPB', 'Aggregate material priced independently in MBT per yard.', 'aggregate_material', NULL, 'YARD', NULL, NULL, 'aggregate.hpb', false),
  ('AGG_SCREENING', 'Screening', 'Aggregate material priced independently in MBT per yard.', 'aggregate_material', NULL, 'YARD', NULL, NULL, 'aggregate.screening', false),
  ('AGG_LOADING', 'Aggregate loading fee', 'One tax-treated CAD 50 loading fee per combined bin visit.', 'loading_fee', NULL, 'VISIT', 5000, NULL, 'aggregate.loading', true),
  ('DUMP_SOIL', 'Soil fixed dump charge', 'Fixed customer dump charge per incoming soil bin.', 'fixed_dump', 'soil', 'BIN', NULL, NULL, 'dump.soil', false),
  ('DUMP_ASPHALT', 'Asphalt fixed dump charge', 'Fixed customer dump charge per incoming asphalt bin.', 'fixed_dump', 'asphalt', 'BIN', NULL, NULL, 'dump.asphalt', false),
  ('DUMP_CONCRETE', 'Concrete fixed dump charge', 'Fixed customer dump charge per incoming concrete bin.', 'fixed_dump', 'concrete', 'BIN', NULL, NULL, 'dump.concrete', false)
ON CONFLICT (item_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS mbt_frontdesk_charge_configurations (
  rate_card_version_id uuid PRIMARY KEY
    REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  complete boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_frontdesk_charge_configurations_revision_positive CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS mbt_frontdesk_charge_rates (
  charge_rate_id uuid PRIMARY KEY,
  rate_card_version_id uuid NOT NULL
    REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  item_code text NOT NULL
    REFERENCES mbt_frontdesk_charge_catalog(item_code) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_frontdesk_charge_rates_amount_nonnegative CHECK (amount_minor >= 0),
  CONSTRAINT mbt_frontdesk_charge_rates_currency_cad CHECK (currency = 'CAD'),
  CONSTRAINT mbt_frontdesk_charge_rates_revision_positive CHECK (revision > 0),
  CONSTRAINT mbt_frontdesk_charge_rates_version_item_unique
    UNIQUE (rate_card_version_id, item_code)
);

CREATE INDEX IF NOT EXISTS idx_mbt_frontdesk_charge_rates_lookup
  ON mbt_frontdesk_charge_rates (rate_card_version_id, item_code, active);

CREATE TABLE IF NOT EXISTS mbt_frontdesk_aggregate_distance_bands (
  aggregate_distance_band_id uuid PRIMARY KEY,
  rate_card_version_id uuid NOT NULL
    REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  band_code text NOT NULL,
  sequence_number integer NOT NULL,
  minimum_metres integer NOT NULL,
  maximum_metres integer,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_code_format
    CHECK (band_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_sequence_positive CHECK (sequence_number > 0),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_range
    CHECK (minimum_metres >= 0 AND (maximum_metres IS NULL OR maximum_metres > minimum_metres)),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_amount_nonnegative CHECK (amount_minor >= 0),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_currency_cad CHECK (currency = 'CAD'),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_revision_positive CHECK (revision > 0),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_version_code_unique
    UNIQUE (rate_card_version_id, band_code),
  CONSTRAINT mbt_frontdesk_aggregate_distance_bands_version_sequence_unique
    UNIQUE (rate_card_version_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_mbt_frontdesk_aggregate_distance_lookup
  ON mbt_frontdesk_aggregate_distance_bands (
    rate_card_version_id, active, minimum_metres, maximum_metres, sequence_number
  );

CREATE TABLE IF NOT EXISTS mbt_frontdesk_charge_requests (
  charge_request_id uuid PRIMARY KEY,
  request_number text NOT NULL UNIQUE,
  request_kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  contract_id uuid REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  service_line_id uuid REFERENCES mbt_contract_service_lines(service_line_id) ON DELETE RESTRICT,
  source_quote_id uuid REFERENCES mbt_quotes(quote_id) ON DELETE RESTRICT,
  rate_card_version_id uuid REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  expected_contract_revision bigint,
  expected_service_line_revision bigint,
  payment_method text NOT NULL,
  payment_category text NOT NULL,
  tax_mode text NOT NULL,
  tax_rate_basis_points integer NOT NULL DEFAULT 1300,
  netsuite_export_policy text NOT NULL,
  pricing_snapshot jsonb NOT NULL,
  netsuite_ready_snapshot jsonb,
  current_contract_total_minor bigint NOT NULL DEFAULT 0,
  pre_tax_revenue_minor bigint NOT NULL,
  included_hst_minor bigint NOT NULL DEFAULT 0,
  added_hst_minor bigint NOT NULL DEFAULT 0,
  request_total_minor bigint NOT NULL,
  resulting_contract_total_minor bigint NOT NULL,
  required_deposit_minor bigint NOT NULL DEFAULT 0,
  due_now_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CAD',
  billing_address_text text NOT NULL,
  service_address_text text NOT NULL,
  contract_telephone text NOT NULL,
  order_from_150 boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  confirmed_at timestamptz,
  confirmed_by text,
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_frontdesk_charge_requests_number_not_blank
    CHECK (NULLIF(btrim(request_number), '') IS NOT NULL),
  CONSTRAINT mbt_frontdesk_charge_requests_kind
    CHECK (request_kind IN ('initial_bin', 'add_bin', 'exchange_bin', 'aggregate_order')),
  CONSTRAINT mbt_frontdesk_charge_requests_status
    CHECK (status IN ('draft', 'confirmed', 'cancelled', 'expired')),
  CONSTRAINT mbt_frontdesk_charge_requests_payment_method
    CHECK (payment_method IN ('cash', 'card', 'debit', 'e_transfer', 'cheque', 'account', 'non_cash')),
  CONSTRAINT mbt_frontdesk_charge_requests_payment_category
    CHECK (payment_category IN ('cash', 'non_cash')),
  CONSTRAINT mbt_frontdesk_charge_requests_tax_mode
    CHECK (tax_mode IN ('included', 'exclusive')),
  CONSTRAINT mbt_frontdesk_charge_requests_hst_13 CHECK (tax_rate_basis_points = 1300),
  CONSTRAINT mbt_frontdesk_charge_requests_export_policy
    CHECK (netsuite_export_policy IN ('excluded_cash', 'eligible_non_cash')),
  CONSTRAINT mbt_frontdesk_charge_requests_snapshots
    CHECK (
      jsonb_typeof(pricing_snapshot) = 'object'
      AND (netsuite_ready_snapshot IS NULL OR jsonb_typeof(netsuite_ready_snapshot) = 'object')
    ),
  CONSTRAINT mbt_frontdesk_charge_requests_amounts_nonnegative
    CHECK (
      current_contract_total_minor >= 0
      AND pre_tax_revenue_minor >= 0
      AND included_hst_minor >= 0
      AND added_hst_minor >= 0
      AND request_total_minor >= 0
      AND resulting_contract_total_minor >= 0
      AND required_deposit_minor >= 0
      AND due_now_minor >= 0
    ),
  CONSTRAINT mbt_frontdesk_charge_requests_total_conservation
    CHECK (resulting_contract_total_minor = current_contract_total_minor + request_total_minor),
  CONSTRAINT mbt_frontdesk_charge_requests_due_now_conservation
    CHECK (
      due_now_minor >= required_deposit_minor
      AND due_now_minor - required_deposit_minor <= request_total_minor
    ),
  CONSTRAINT mbt_frontdesk_charge_requests_payment_tax_export
    CHECK (
      (
        payment_method = 'cash'
        AND payment_category = 'cash'
        AND tax_mode = 'included'
        AND netsuite_export_policy = 'excluded_cash'
        AND added_hst_minor = 0
        AND netsuite_ready_snapshot IS NULL
        AND request_total_minor = pre_tax_revenue_minor + included_hst_minor
      )
      OR (
        payment_method <> 'cash'
        AND payment_category = 'non_cash'
        AND tax_mode = 'exclusive'
        AND netsuite_export_policy = 'eligible_non_cash'
        AND included_hst_minor = 0
        AND netsuite_ready_snapshot IS NOT NULL
        AND request_total_minor = pre_tax_revenue_minor + added_hst_minor
      )
    ),
  CONSTRAINT mbt_frontdesk_charge_requests_subject_shape
    CHECK (
      (request_kind = 'aggregate_order' AND contract_id IS NULL AND service_line_id IS NULL)
      OR (request_kind = 'initial_bin' AND service_line_id IS NULL)
      OR (request_kind = 'add_bin' AND contract_id IS NOT NULL AND service_line_id IS NULL)
      OR (request_kind = 'exchange_bin' AND contract_id IS NOT NULL AND service_line_id IS NOT NULL)
    ),
  CONSTRAINT mbt_frontdesk_charge_requests_revisions
    CHECK (
      (expected_contract_revision IS NULL OR expected_contract_revision > 0)
      AND (expected_service_line_revision IS NULL OR expected_service_line_revision > 0)
      AND revision > 0
    ),
  CONSTRAINT mbt_frontdesk_charge_requests_contact_snapshots
    CHECK (
      NULLIF(btrim(billing_address_text), '') IS NOT NULL
      AND NULLIF(btrim(service_address_text), '') IS NOT NULL
      AND NULLIF(btrim(contract_telephone), '') IS NOT NULL
      AND NULLIF(btrim(reason), '') IS NOT NULL
    ),
  CONSTRAINT mbt_frontdesk_charge_requests_confirmation_complete
    CHECK (
      (status <> 'confirmed' AND confirmed_at IS NULL AND confirmed_by IS NULL)
      OR (
        status = 'confirmed'
        AND confirmed_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(confirmed_by, '')), '') IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_mbt_frontdesk_charge_requests_contract
  ON mbt_frontdesk_charge_requests (contract_id, status, created_at, charge_request_id)
  WHERE contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mbt_frontdesk_charge_requests_export
  ON mbt_frontdesk_charge_requests (netsuite_export_policy, status, confirmed_at, charge_request_id)
  WHERE netsuite_export_policy = 'eligible_non_cash';

CREATE TABLE IF NOT EXISTS mbt_frontdesk_charge_request_lines (
  charge_request_line_id uuid PRIMARY KEY,
  charge_request_id uuid NOT NULL
    REFERENCES mbt_frontdesk_charge_requests(charge_request_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL,
  line_code text NOT NULL,
  line_type text NOT NULL,
  description text NOT NULL,
  item_code text,
  quantity_milli_units integer NOT NULL DEFAULT 1000,
  unit_of_measure text NOT NULL,
  unit_amount_minor bigint NOT NULL,
  configured_amount_minor bigint NOT NULL,
  pre_tax_amount_minor bigint NOT NULL,
  included_hst_minor bigint NOT NULL DEFAULT 0,
  added_hst_minor bigint NOT NULL DEFAULT 0,
  customer_amount_minor bigint NOT NULL,
  taxable boolean NOT NULL DEFAULT true,
  payment_timing text NOT NULL,
  pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_frontdesk_charge_request_lines_sequence_positive CHECK (sequence_number > 0),
  CONSTRAINT mbt_frontdesk_charge_request_lines_codes_not_blank
    CHECK (NULLIF(btrim(line_code), '') IS NOT NULL AND NULLIF(btrim(line_type), '') IS NOT NULL),
  CONSTRAINT mbt_frontdesk_charge_request_lines_description_not_blank
    CHECK (NULLIF(btrim(description), '') IS NOT NULL),
  CONSTRAINT mbt_frontdesk_charge_request_lines_quantity_positive CHECK (quantity_milli_units > 0),
  CONSTRAINT mbt_frontdesk_charge_request_lines_uom
    CHECK (unit_of_measure IN ('EA', 'BIN', 'TRIP', 'VISIT', 'YARD', 'KM')),
  CONSTRAINT mbt_frontdesk_charge_request_lines_unit_amount_nonnegative CHECK (unit_amount_minor >= 0),
  -- Discount lines are negative taxable evidence, so their HST contribution
  -- is also negative. The parent request constrains the final HST totals to be
  -- non-negative and conserves the complete customer amount.
  CONSTRAINT mbt_frontdesk_charge_request_lines_tax_conservation
    CHECK (
      customer_amount_minor
        = pre_tax_amount_minor + included_hst_minor + added_hst_minor
    ),
  CONSTRAINT mbt_frontdesk_charge_request_lines_payment_timing
    CHECK (payment_timing IN ('due_now', 'contract_balance')),
  CONSTRAINT mbt_frontdesk_charge_request_lines_snapshot_object
    CHECK (jsonb_typeof(pricing_snapshot) = 'object'),
  CONSTRAINT mbt_frontdesk_charge_request_lines_request_sequence_unique
    UNIQUE (charge_request_id, sequence_number),
  CONSTRAINT mbt_frontdesk_charge_request_lines_request_code_unique
    UNIQUE (charge_request_id, line_code)
);

CREATE INDEX IF NOT EXISTS idx_mbt_frontdesk_charge_request_lines_request
  ON mbt_frontdesk_charge_request_lines (charge_request_id, sequence_number, charge_request_line_id);

ALTER TABLE mbt_contract_service_lines
  ADD COLUMN IF NOT EXISTS source_charge_request_id uuid;

-- New fixed-per-bin dump pricing no longer asks Front Desk for estimated
-- tonnes. Retain complete legacy estimates, while allowing a current bin item
-- identity with no dump/material/weight estimate at all.
ALTER TABLE mbt_contract_service_lines
  DROP CONSTRAINT IF EXISTS mbt_contract_service_lines_dump_estimate_complete;
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

  IF NEW.bin_item_code IS NULL THEN
    RAISE EXCEPTION 'physical-bin item evidence is incomplete'
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

  IF NEW.dump_item_code IS NULL
     AND NEW.material_id IS NULL
     AND NEW.estimated_weight_kg IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.dump_item_code IS NULL
     OR NEW.material_id IS NULL
     OR NEW.estimated_weight_kg IS NULL
     OR NEW.estimated_weight_kg NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'legacy physical-bin dump estimate evidence is incomplete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_contract_service_lines_dump_estimate_complete';
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

ALTER TABLE mbt_contract_service_lines
  DROP CONSTRAINT IF EXISTS mbt_contract_service_lines_source_charge_request_fk;
ALTER TABLE mbt_contract_service_lines
  ADD CONSTRAINT mbt_contract_service_lines_source_charge_request_fk
    FOREIGN KEY (source_charge_request_id)
    REFERENCES mbt_frontdesk_charge_requests(charge_request_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_contract_service_lines_source_charge_request
  ON mbt_contract_service_lines (source_charge_request_id)
  WHERE source_charge_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbt_guard_confirmed_charge_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer charge requests are retained as pricing evidence'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION 'confirmed customer charge requests are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.charge_request_id IS DISTINCT FROM OLD.charge_request_id
     OR NEW.request_number IS DISTINCT FROM OLD.request_number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer charge request identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'customer charge request revisions must advance exactly once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mbt_guard_confirmed_charge_request
  BEFORE UPDATE OR DELETE ON mbt_frontdesk_charge_requests
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_confirmed_charge_request();

CREATE OR REPLACE FUNCTION mbt_guard_charge_request_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_request_id uuid;
  target_status text;
BEGIN
  target_request_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.charge_request_id ELSE NEW.charge_request_id END;
  SELECT status INTO target_status
    FROM mbt_frontdesk_charge_requests
   WHERE charge_request_id = target_request_id;
  IF target_status = 'confirmed' THEN
    RAISE EXCEPTION 'confirmed customer charge request lines are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mbt_guard_charge_request_line
  BEFORE INSERT OR UPDATE OR DELETE ON mbt_frontdesk_charge_request_lines
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_charge_request_line();

ALTER TABLE dispatch_custom_orders
  ADD COLUMN IF NOT EXISTS mbt_charge_request_id uuid;

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_mbt_charge_request_fk;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_mbt_charge_request_fk
    FOREIGN KEY (mbt_charge_request_id)
    REFERENCES mbt_frontdesk_charge_requests(charge_request_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_custom_orders_mbt_charge_request
  ON dispatch_custom_orders (mbt_charge_request_id)
  WHERE mbt_charge_request_id IS NOT NULL;

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_mbt_source_valid;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_mbt_source_valid
    CHECK (mbt_source IS NULL OR mbt_source IN ('frontdesk_delivery', 'frontdesk_aggregate'));

COMMENT ON TABLE mbt_frontdesk_charge_requests IS
  'Immutable after confirmation: one locally priced customer request with cash-included or non-cash-exclusive HST evidence.';
COMMENT ON COLUMN mbt_frontdesk_charge_requests.netsuite_ready_snapshot IS
  'Future-only pre-tax line evidence. This migration does not enqueue or call a NetSuite write.';
COMMENT ON COLUMN mbt_frontdesk_charge_catalog.density_lbs_per_yard IS
  'Dispatch-only derived-weight evidence; customer pricing and future invoice quantities remain YARD.';
