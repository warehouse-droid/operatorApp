-- Billing-only destination corrections for completed MBBS candidates. These
-- rows never update the retained Driver PWA, reconciliation, or NetSuite mirror
-- evidence from which a candidate was discovered.

CREATE TABLE IF NOT EXISTS mbt_mbbs_billing_address_overrides (
  address_override_id uuid PRIMARY KEY,
  candidate_id text NOT NULL UNIQUE,
  source_system text NOT NULL,
  source_record_id text NOT NULL,
  destination_address_text text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_mbbs_billing_address_candidate_not_blank
    CHECK (NULLIF(btrim(candidate_id), '') IS NOT NULL AND length(candidate_id) <= 500),
  CONSTRAINT mbt_mbbs_billing_address_source
    CHECK (source_system IN ('driver_pwa', 'reconciliation', 'sales_order')),
  CONSTRAINT mbt_mbbs_billing_address_source_record_not_blank
    CHECK (NULLIF(btrim(source_record_id), '') IS NOT NULL),
  CONSTRAINT mbt_mbbs_billing_address_text_not_blank
    CHECK (
      NULLIF(btrim(destination_address_text), '') IS NOT NULL
      AND length(destination_address_text) <= 1000
    ),
  CONSTRAINT mbt_mbbs_billing_address_revision_positive
    CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS idx_mbt_mbbs_billing_address_source
  ON mbt_mbbs_billing_address_overrides (source_system, source_record_id);

COMMENT ON TABLE mbt_mbbs_billing_address_overrides IS
  'Audited local billing-only destination corrections; operational order and Driver PWA evidence remains unchanged.';
