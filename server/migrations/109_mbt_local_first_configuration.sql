-- MBT local-first configuration and billing-posting intent.
-- This migration introduces local catalog and immutable billing evidence only.
-- It creates no NetSuite credential, request, scheduler, worker, or write gate.

CREATE TABLE IF NOT EXISTS mbt_local_item_settings (
  item_code text PRIMARY KEY,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL,
  bin_type_id uuid REFERENCES mbt_bin_types(bin_type_id) ON DELETE RESTRICT,
  pricing_mode text NOT NULL,
  netsuite_mapping_local_key text,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_local_item_settings_code
    CHECK (item_code IN ('DELIVERY_CROSS_CHARGE', '14YD', '20YD', '40YD', 'DUMP')),
  CONSTRAINT mbt_local_item_settings_display_name
    CHECK (
      NULLIF(btrim(display_name), '') IS NOT NULL
      AND char_length(display_name) <= 160
    ),
  CONSTRAINT mbt_local_item_settings_description_length
    CHECK (char_length(description) <= 2000),
  CONSTRAINT mbt_local_item_settings_category
    CHECK (category IN ('cross_charge', 'bin_charge', 'dump')),
  CONSTRAINT mbt_local_item_settings_pricing_mode
    CHECK (pricing_mode IN ('calculated', 'rate_card', 'custom_price')),
  CONSTRAINT mbt_local_item_settings_mapping_key
    CHECK (
      netsuite_mapping_local_key IS NULL
      OR netsuite_mapping_local_key ~ '^[a-z][a-z0-9_.:-]*$'
    ),
  CONSTRAINT mbt_local_item_settings_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_local_item_settings_identity_shape
    CHECK (
      (
        item_code = 'DELIVERY_CROSS_CHARGE'
        AND category = 'cross_charge'
        AND bin_type_id IS NULL
        AND pricing_mode = 'calculated'
        AND netsuite_mapping_local_key IS NOT NULL
        AND netsuite_mapping_local_key = 'delivery_charge'
      )
      OR
      (
        item_code = '14YD'
        AND category = 'bin_charge'
        AND bin_type_id IS NOT NULL
        AND bin_type_id = '00000000-0000-4000-8000-000000000014'::uuid
        AND pricing_mode = 'rate_card'
        AND netsuite_mapping_local_key IS NOT NULL
        AND netsuite_mapping_local_key = 'bin_14yd'
      )
      OR
      (
        item_code = '20YD'
        AND category = 'bin_charge'
        AND bin_type_id IS NOT NULL
        AND bin_type_id = '00000000-0000-4000-8000-000000000020'::uuid
        AND pricing_mode = 'rate_card'
        AND netsuite_mapping_local_key IS NOT NULL
        AND netsuite_mapping_local_key = 'bin_20yd'
      )
      OR
      (
        item_code = '40YD'
        AND category = 'bin_charge'
        AND bin_type_id IS NOT NULL
        AND bin_type_id = '00000000-0000-4000-8000-000000000040'::uuid
        AND pricing_mode = 'rate_card'
        AND netsuite_mapping_local_key IS NOT NULL
        AND netsuite_mapping_local_key = 'bin_40yd'
      )
      OR
      (
        item_code = 'DUMP'
        AND category = 'dump'
        AND bin_type_id IS NULL
        AND pricing_mode = 'custom_price'
        AND netsuite_mapping_local_key IS NULL
      )
    )
);

INSERT INTO mbt_local_item_settings (
  item_code,
  display_name,
  description,
  category,
  bin_type_id,
  pricing_mode,
  netsuite_mapping_local_key,
  active,
  revision,
  created_by,
  updated_by
)
VALUES
  (
    'DELIVERY_CROSS_CHARGE',
    'Delivery Charge - MBT',
    'Calculated locally from the approved cross-charge rate.',
    'cross_charge',
    NULL,
    'calculated',
    'delivery_charge',
    true,
    1,
    'migration:109',
    'migration:109'
  ),
  (
    '14YD',
    '14YD',
    'Price comes from the approved rate card.',
    'bin_charge',
    '00000000-0000-4000-8000-000000000014',
    'rate_card',
    'bin_14yd',
    true,
    1,
    'migration:109',
    'migration:109'
  ),
  (
    '20YD',
    '20YD',
    'Price comes from the approved rate card.',
    'bin_charge',
    '00000000-0000-4000-8000-000000000020',
    'rate_card',
    'bin_20yd',
    true,
    1,
    'migration:109',
    'migration:109'
  ),
  (
    '40YD',
    '40YD',
    'Price comes from the approved rate card.',
    'bin_charge',
    '00000000-0000-4000-8000-000000000040',
    'rate_card',
    'bin_40yd',
    true,
    1,
    'migration:109',
    'migration:109'
  ),
  (
    'DUMP',
    'DUMP',
    'Custom price is captured on each immutable billing line.',
    'dump',
    NULL,
    'custom_price',
    NULL,
    true,
    1,
    'migration:109',
    'migration:109'
  )
ON CONFLICT (item_code) DO NOTHING;

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
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.bin_type_id IS DISTINCT FROM OLD.bin_type_id
     OR NEW.pricing_mode IS DISTINCT FROM OLD.pricing_mode
     OR NEW.netsuite_mapping_local_key IS DISTINCT FROM OLD.netsuite_mapping_local_key
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MBT local item identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'MBT local item revisions must advance exactly once per update'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_local_item_settings_guard
  ON mbt_local_item_settings;
CREATE TRIGGER trg_mbt_local_item_settings_guard
  BEFORE UPDATE OR DELETE ON mbt_local_item_settings
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_local_item_setting_mutation();

ALTER TABLE mbt_billing_cases
  ADD COLUMN IF NOT EXISTS posting_mode text NOT NULL DEFAULT 'local_only';

ALTER TABLE mbt_billing_versions
  ADD COLUMN IF NOT EXISTS posting_mode text NOT NULL DEFAULT 'local_only';
ALTER TABLE mbt_billing_versions
  ADD COLUMN IF NOT EXISTS billing_case_revision_before bigint;
ALTER TABLE mbt_billing_versions
  DROP CONSTRAINT IF EXISTS mbt_billing_versions_case_revision_before_positive;
ALTER TABLE mbt_billing_versions
  ADD CONSTRAINT mbt_billing_versions_case_revision_before_positive
    CHECK (
      billing_case_revision_before IS NULL
      OR billing_case_revision_before > 0
    );

-- Migration 106 made billing versions immutable. Temporarily remove only that
-- trigger while classifying pre-109 external intent from durable local
-- evidence. The enclosing migration transaction restores the trigger even if
-- any later statement fails by rolling the whole migration back.
DROP TRIGGER IF EXISTS trg_mbt_billing_versions_immutable
  ON mbt_billing_versions;

UPDATE mbt_billing_versions AS v
   SET posting_mode = 'netsuite_future'
 WHERE v.posting_mode IS DISTINCT FROM 'netsuite_future'
   AND (
     EXISTS (
       SELECT 1
         FROM mbt_netsuite_sales_order_chain chain
        WHERE chain.billing_version_id = v.billing_version_id
     )
     OR EXISTS (
       SELECT 1
         FROM mbt_netsuite_outbox outbox
         LEFT JOIN mbt_netsuite_sales_order_chain chain
           ON chain.sales_order_chain_id = outbox.sales_order_chain_id
        WHERE (
          outbox.target_record_type = 'sales_order'
          OR outbox.operation_type IN ('create_sales_order', 'update_sales_order')
        )
          AND (
            outbox.billing_version_id = v.billing_version_id
            OR chain.billing_version_id = v.billing_version_id
          )
     )
   );

UPDATE mbt_billing_versions
   SET posting_mode = 'local_only'
 WHERE posting_mode IS NULL;

CREATE TRIGGER trg_mbt_billing_versions_immutable
  BEFORE UPDATE OR DELETE ON mbt_billing_versions
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_billing_version_mutation();

UPDATE mbt_billing_cases AS billing_case
   SET posting_mode = 'netsuite_future'
 WHERE billing_case.posting_mode IS DISTINCT FROM 'netsuite_future'
   AND EXISTS (
     SELECT 1
       FROM mbt_billing_versions v
      WHERE v.billing_case_id = billing_case.billing_case_id
        AND v.posting_mode = 'netsuite_future'
   );

UPDATE mbt_billing_cases
   SET posting_mode = 'local_only'
 WHERE posting_mode IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM mbt_billing_versions v
      JOIN mbt_billing_cases billing_case
        ON billing_case.billing_case_id = v.billing_case_id
     WHERE (
       EXISTS (
         SELECT 1
           FROM mbt_netsuite_sales_order_chain chain
          WHERE chain.billing_version_id = v.billing_version_id
       )
       OR EXISTS (
         SELECT 1
           FROM mbt_netsuite_outbox outbox
           LEFT JOIN mbt_netsuite_sales_order_chain chain
             ON chain.sales_order_chain_id = outbox.sales_order_chain_id
          WHERE (
            outbox.target_record_type = 'sales_order'
            OR outbox.operation_type IN ('create_sales_order', 'update_sales_order')
          )
            AND (
              outbox.billing_version_id = v.billing_version_id
              OR chain.billing_version_id = v.billing_version_id
            )
       )
     )
       AND (
         v.posting_mode IS DISTINCT FROM 'netsuite_future'
         OR billing_case.posting_mode IS DISTINCT FROM 'netsuite_future'
       )
  ) THEN
    RAISE EXCEPTION 'Durable Sales Order evidence cannot remain classified as local-only'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_posting_mode_external_evidence';
  END IF;
END;
$$;

ALTER TABLE mbt_billing_cases
  ALTER COLUMN posting_mode SET DEFAULT 'local_only',
  ALTER COLUMN posting_mode SET NOT NULL;
ALTER TABLE mbt_billing_cases
  DROP CONSTRAINT IF EXISTS mbt_billing_cases_posting_mode;
ALTER TABLE mbt_billing_cases
  ADD CONSTRAINT mbt_billing_cases_posting_mode
    CHECK (posting_mode IN ('local_only', 'netsuite_future'));

ALTER TABLE mbt_billing_versions
  ALTER COLUMN posting_mode SET DEFAULT 'local_only',
  ALTER COLUMN posting_mode SET NOT NULL;
ALTER TABLE mbt_billing_versions
  DROP CONSTRAINT IF EXISTS mbt_billing_versions_posting_mode;
ALTER TABLE mbt_billing_versions
  ADD CONSTRAINT mbt_billing_versions_posting_mode
    CHECK (posting_mode IN ('local_only', 'netsuite_future'));

-- Historical rows cannot be assigned an exact prior case revision safely.
-- NOT VALID preserves those rows while still rejecting every new or changed
-- version that omits the immutable approval revision evidence.
ALTER TABLE mbt_billing_versions
  DROP CONSTRAINT IF EXISTS mbt_billing_versions_revision_evidence_required;
ALTER TABLE mbt_billing_versions
  ADD CONSTRAINT mbt_billing_versions_revision_evidence_required
    CHECK (billing_case_revision_before IS NOT NULL)
    NOT VALID;

ALTER TABLE mbt_billing_lines
  ADD COLUMN IF NOT EXISTS local_item_code text,
  ADD COLUMN IF NOT EXISTS local_item_revision bigint,
  ALTER COLUMN netsuite_item_mapping_key DROP NOT NULL;
ALTER TABLE mbt_billing_lines
  DROP CONSTRAINT IF EXISTS mbt_billing_lines_mapping_key_not_blank;
ALTER TABLE mbt_billing_lines
  ADD CONSTRAINT mbt_billing_lines_mapping_key_not_blank
    CHECK (
      netsuite_item_mapping_key IS NULL
      OR NULLIF(btrim(netsuite_item_mapping_key), '') IS NOT NULL
    ),
  ADD CONSTRAINT mbt_billing_lines_local_item_complete
    CHECK (
      (
        local_item_code IS NULL
        AND local_item_revision IS NULL
      )
      OR
      (
        local_item_code IS NOT NULL
        AND NULLIF(btrim(local_item_code), '') IS NOT NULL
        AND local_item_revision IS NOT NULL
        AND local_item_revision > 0
      )
    ),
  ADD CONSTRAINT mbt_billing_lines_item_identity_present
    CHECK (
      local_item_code IS NOT NULL
      OR netsuite_item_mapping_key IS NOT NULL
    ),
  ADD CONSTRAINT mbt_billing_lines_local_item_fk
    FOREIGN KEY (local_item_code)
    REFERENCES mbt_local_item_settings(item_code)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION mbt_reject_local_only_sales_order_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM mbt_billing_versions v
     WHERE v.billing_version_id = NEW.billing_version_id
       AND v.posting_mode = 'local_only'
  ) THEN
    RAISE EXCEPTION 'A local-only billing version cannot create a NetSuite Sales Order chain'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_local_only_sales_order_chain';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_local_only_sales_order_chain
  ON mbt_netsuite_sales_order_chain;
CREATE TRIGGER trg_mbt_local_only_sales_order_chain
  BEFORE INSERT OR UPDATE
  ON mbt_netsuite_sales_order_chain
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_local_only_sales_order_chain();

CREATE OR REPLACE FUNCTION mbt_reject_local_only_sales_order_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  local_only_version_exists boolean;
BEGIN
  IF NEW.target_record_type <> 'sales_order'
     AND NEW.operation_type NOT IN ('create_sales_order', 'update_sales_order') THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM mbt_billing_versions v
     WHERE v.posting_mode = 'local_only'
       AND (
         v.billing_version_id = NEW.billing_version_id
         OR v.billing_version_id = (
           SELECT chain.billing_version_id
             FROM mbt_netsuite_sales_order_chain chain
            WHERE chain.sales_order_chain_id = NEW.sales_order_chain_id
         )
       )
  )
    INTO local_only_version_exists;
  IF local_only_version_exists THEN
    RAISE EXCEPTION 'A local-only billing version cannot create NetSuite Sales Order work'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_local_only_sales_order_outbox';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_local_only_sales_order_outbox
  ON mbt_netsuite_outbox;
CREATE TRIGGER trg_mbt_local_only_sales_order_outbox
  BEFORE INSERT OR UPDATE
  ON mbt_netsuite_outbox
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_local_only_sales_order_outbox();

COMMENT ON TABLE mbt_local_item_settings IS
  'Local MBT billable-item presentation and server-owned pricing policy; it does not require NetSuite configuration.';

COMMENT ON COLUMN mbt_billing_cases.posting_mode IS
  'Local-only or future-NetSuite intent. Neither value authorizes external work in this phase.';

COMMENT ON COLUMN mbt_billing_versions.posting_mode IS
  'Immutable approval-time snapshot of the billing case posting intent.';
