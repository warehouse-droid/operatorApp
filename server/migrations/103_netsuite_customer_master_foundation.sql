-- Shared NetSuite-authoritative customer mirror foundations. This migration
-- creates storage only; customer synchronization remains disabled in Phase 1.

CREATE TABLE IF NOT EXISTS netsuite_customer_sync_runs (
  run_id uuid PRIMARY KEY,
  sync_kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  account_id text NOT NULL,
  subsidiary_id bigint,
  requested_by text,
  correlation_id text NOT NULL,
  source_window_start timestamptz,
  source_window_end timestamptz,
  source_high_watermark timestamptz,
  pages_expected integer,
  pages_applied integer NOT NULL DEFAULT 0,
  records_seen bigint NOT NULL DEFAULT 0,
  records_applied bigint NOT NULL DEFAULT 0,
  records_conflicted bigint NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_customer_sync_runs_kind
    CHECK (sync_kind IN ('incremental', 'full_reconciliation')),
  CONSTRAINT netsuite_customer_sync_runs_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial', 'cancelled')),
  CONSTRAINT netsuite_customer_sync_runs_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_sync_runs_subsidiary_positive
    CHECK (subsidiary_id IS NULL OR subsidiary_id > 0),
  CONSTRAINT netsuite_customer_sync_runs_correlation_not_blank
    CHECK (NULLIF(btrim(correlation_id), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_sync_runs_page_counts
    CHECK (
      (pages_expected IS NULL OR pages_expected >= 0)
      AND pages_applied >= 0
      AND (pages_expected IS NULL OR pages_applied <= pages_expected)
    ),
  CONSTRAINT netsuite_customer_sync_runs_record_counts
    CHECK (records_seen >= 0 AND records_applied >= 0 AND records_conflicted >= 0),
  CONSTRAINT netsuite_customer_sync_runs_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT netsuite_customer_sync_runs_window_order
    CHECK (
      source_window_start IS NULL
      OR source_window_end IS NULL
      OR source_window_end >= source_window_start
    ),
  CONSTRAINT netsuite_customer_sync_runs_completed_after_start
    CHECK (started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_netsuite_customer_sync_runs_status
  ON netsuite_customer_sync_runs (status, requested_at, run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_netsuite_customer_sync_runs_one_active
  ON netsuite_customer_sync_runs (sync_kind, account_id, COALESCE(subsidiary_id, 0))
  WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS netsuite_customer_sync_pages (
  page_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  page_number integer NOT NULL,
  source_cursor_start text,
  source_cursor_end text,
  payload_hash text NOT NULL,
  record_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  error_code text,
  error_message text,
  received_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_customer_sync_pages_number_nonnegative
    CHECK (page_number >= 0),
  CONSTRAINT netsuite_customer_sync_pages_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT netsuite_customer_sync_pages_record_count_nonnegative
    CHECK (record_count >= 0),
  CONSTRAINT netsuite_customer_sync_pages_status
    CHECK (status IN ('pending', 'received', 'applied', 'failed', 'conflicted')),
  CONSTRAINT netsuite_customer_sync_pages_applied_after_received
    CHECK (received_at IS NULL OR applied_at IS NULL OR applied_at >= received_at),
  CONSTRAINT netsuite_customer_sync_pages_run_number_unique
    UNIQUE (run_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_netsuite_customer_sync_pages_work
  ON netsuite_customer_sync_pages (run_id, status, page_number);

CREATE TABLE IF NOT EXISTS netsuite_customers (
  netsuite_id bigint PRIMARY KEY,
  entity_number text NOT NULL,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  currency text NOT NULL,
  terms text,
  tax_status text,
  credit_status text,
  email text,
  phone text,
  active boolean NOT NULL DEFAULT true,
  source_modified_at timestamptz NOT NULL,
  source_version text NOT NULL,
  payload_hash text NOT NULL,
  last_seen_run_id uuid REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_customers_id_positive
    CHECK (netsuite_id > 0),
  CONSTRAINT netsuite_customers_entity_not_blank
    CHECK (NULLIF(btrim(entity_number), '') IS NOT NULL),
  CONSTRAINT netsuite_customers_legal_name_not_blank
    CHECK (NULLIF(btrim(legal_name), '') IS NOT NULL),
  CONSTRAINT netsuite_customers_display_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT netsuite_customers_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT netsuite_customers_source_version_not_blank
    CHECK (NULLIF(btrim(source_version), '') IS NOT NULL),
  CONSTRAINT netsuite_customers_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_netsuite_customers_entity_number
  ON netsuite_customers (entity_number);

CREATE INDEX IF NOT EXISTS idx_netsuite_customers_selection
  ON netsuite_customers (active, lower(display_name), netsuite_id);

CREATE INDEX IF NOT EXISTS idx_netsuite_customers_source_modified
  ON netsuite_customers (source_modified_at, netsuite_id);

CREATE TABLE IF NOT EXISTS netsuite_customer_subsidiaries (
  customer_netsuite_id bigint NOT NULL REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  subsidiary_netsuite_id bigint NOT NULL,
  relationship_name text NOT NULL DEFAULT '',
  primary_relationship boolean NOT NULL DEFAULT false,
  currency text,
  terms text,
  tax_status text,
  credit_status text,
  active boolean NOT NULL DEFAULT true,
  source_modified_at timestamptz NOT NULL,
  source_version text NOT NULL,
  payload_hash text NOT NULL,
  last_seen_run_id uuid REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_netsuite_id, subsidiary_netsuite_id),
  CONSTRAINT netsuite_customer_subsidiaries_id_positive
    CHECK (subsidiary_netsuite_id > 0),
  CONSTRAINT netsuite_customer_subsidiaries_currency_iso
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT netsuite_customer_subsidiaries_source_version_not_blank
    CHECK (NULLIF(btrim(source_version), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_subsidiaries_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_netsuite_customer_subsidiaries_active
  ON netsuite_customer_subsidiaries (subsidiary_netsuite_id, active, customer_netsuite_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_netsuite_customer_subsidiaries_primary
  ON netsuite_customer_subsidiaries (customer_netsuite_id)
  WHERE primary_relationship AND active;

CREATE TABLE IF NOT EXISTS netsuite_customer_addresses (
  address_id uuid PRIMARY KEY,
  customer_netsuite_id bigint NOT NULL REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  netsuite_address_id text NOT NULL,
  label text NOT NULL DEFAULT '',
  billing_default boolean NOT NULL DEFAULT false,
  shipping_default boolean NOT NULL DEFAULT false,
  addressee text NOT NULL DEFAULT '',
  attention text NOT NULL DEFAULT '',
  address_line_1 text NOT NULL DEFAULT '',
  address_line_2 text NOT NULL DEFAULT '',
  address_line_3 text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  country_code text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  source_modified_at timestamptz NOT NULL,
  source_version text NOT NULL,
  payload_hash text NOT NULL,
  last_seen_run_id uuid REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_customer_addresses_external_id_not_blank
    CHECK (NULLIF(btrim(netsuite_address_id), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_addresses_country_format
    CHECK (country_code = '' OR country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT netsuite_customer_addresses_source_version_not_blank
    CHECK (NULLIF(btrim(source_version), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_addresses_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT netsuite_customer_addresses_external_id_unique
    UNIQUE (customer_netsuite_id, netsuite_address_id),
  CONSTRAINT netsuite_customer_addresses_customer_id_unique
    UNIQUE (customer_netsuite_id, address_id)
);

CREATE INDEX IF NOT EXISTS idx_netsuite_customer_addresses_selection
  ON netsuite_customer_addresses (
    customer_netsuite_id,
    active,
    shipping_default DESC,
    billing_default DESC,
    netsuite_address_id
  );

CREATE TABLE IF NOT EXISTS netsuite_customer_contacts (
  contact_id uuid PRIMARY KEY,
  customer_netsuite_id bigint NOT NULL REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  netsuite_contact_id text NOT NULL,
  display_name text NOT NULL,
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  job_title text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  mobile_phone text NOT NULL DEFAULT '',
  primary_contact boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  source_modified_at timestamptz NOT NULL,
  source_version text NOT NULL,
  payload_hash text NOT NULL,
  last_seen_run_id uuid REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_customer_contacts_external_id_not_blank
    CHECK (NULLIF(btrim(netsuite_contact_id), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_contacts_display_name_not_blank
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_contacts_source_version_not_blank
    CHECK (NULLIF(btrim(source_version), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_contacts_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT netsuite_customer_contacts_external_id_unique
    UNIQUE (customer_netsuite_id, netsuite_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_netsuite_customer_contacts_selection
  ON netsuite_customer_contacts (
    customer_netsuite_id,
    active,
    primary_contact DESC,
    netsuite_contact_id
  );

CREATE TABLE IF NOT EXISTS netsuite_customer_sync_state (
  sync_key text PRIMARY KEY,
  account_id text NOT NULL,
  subsidiary_id bigint,
  incremental_cursor_modified_at timestamptz,
  incremental_cursor_external_id text,
  last_incremental_run_id uuid REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  last_complete_full_run_id uuid REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  last_success_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_customer_sync_state_key_not_blank
    CHECK (NULLIF(btrim(sync_key), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_sync_state_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_sync_state_subsidiary_positive
    CHECK (subsidiary_id IS NULL OR subsidiary_id > 0),
  CONSTRAINT netsuite_customer_sync_state_revision_positive
    CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS netsuite_customer_sync_conflicts (
  conflict_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES netsuite_customer_sync_runs(run_id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  customer_netsuite_id bigint,
  external_id text NOT NULL,
  current_source_modified_at timestamptz,
  incoming_source_modified_at timestamptz NOT NULL,
  current_payload_hash text,
  incoming_payload_hash text NOT NULL,
  current_snapshot jsonb,
  incoming_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_customer_sync_conflicts_entity_type
    CHECK (entity_type IN ('customer', 'address', 'contact', 'subsidiary')),
  CONSTRAINT netsuite_customer_sync_conflicts_customer_positive
    CHECK (customer_netsuite_id IS NULL OR customer_netsuite_id > 0),
  CONSTRAINT netsuite_customer_sync_conflicts_external_id_not_blank
    CHECK (NULLIF(btrim(external_id), '') IS NOT NULL),
  CONSTRAINT netsuite_customer_sync_conflicts_current_hash_sha256
    CHECK (current_payload_hash IS NULL OR current_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT netsuite_customer_sync_conflicts_incoming_hash_sha256
    CHECK (incoming_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT netsuite_customer_sync_conflicts_current_snapshot_object
    CHECK (current_snapshot IS NULL OR jsonb_typeof(current_snapshot) = 'object'),
  CONSTRAINT netsuite_customer_sync_conflicts_incoming_snapshot_object
    CHECK (jsonb_typeof(incoming_snapshot) = 'object'),
  CONSTRAINT netsuite_customer_sync_conflicts_status
    CHECK (status IN ('open', 'resolved_current', 'resolved_incoming', 'ignored')),
  CONSTRAINT netsuite_customer_sync_conflicts_resolution
    CHECK (
      (status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
      OR
      (
        status <> 'open'
        AND resolved_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(resolved_by, '')), '') IS NOT NULL
        AND NULLIF(btrim(COALESCE(resolution_note, '')), '') IS NOT NULL
      )
    ),
  CONSTRAINT netsuite_customer_sync_conflicts_revision_positive
    CHECK (revision > 0),
  CONSTRAINT netsuite_customer_sync_conflicts_run_entity_unique
    UNIQUE (run_id, entity_type, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_netsuite_customer_sync_conflicts_open
  ON netsuite_customer_sync_conflicts (
    entity_type,
    COALESCE(customer_netsuite_id, 0),
    external_id
  )
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_netsuite_customer_sync_conflicts_review
  ON netsuite_customer_sync_conflicts (status, created_at, conflict_id);

CREATE TABLE IF NOT EXISTS mbt_customer_site_profiles (
  site_profile_id uuid PRIMARY KEY,
  customer_netsuite_id bigint NOT NULL REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  address_id uuid NOT NULL,
  site_instructions text NOT NULL DEFAULT '',
  access_restrictions text NOT NULL DEFAULT '',
  gate_code text NOT NULL DEFAULT '',
  contact_on_arrival_notes text NOT NULL DEFAULT '',
  geocode_latitude numeric(9, 6),
  geocode_longitude numeric(9, 6),
  geocode_override_reason text NOT NULL DEFAULT '',
  deposit_exception boolean NOT NULL DEFAULT false,
  deposit_exception_reason text NOT NULL DEFAULT '',
  service_warnings text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_customer_site_profiles_address_fk
    FOREIGN KEY (customer_netsuite_id, address_id)
    REFERENCES netsuite_customer_addresses(customer_netsuite_id, address_id)
    ON DELETE RESTRICT,
  CONSTRAINT mbt_customer_site_profiles_latitude
    CHECK (geocode_latitude IS NULL OR geocode_latitude BETWEEN -90 AND 90),
  CONSTRAINT mbt_customer_site_profiles_longitude
    CHECK (geocode_longitude IS NULL OR geocode_longitude BETWEEN -180 AND 180),
  CONSTRAINT mbt_customer_site_profiles_geocode_pair
    CHECK ((geocode_latitude IS NULL) = (geocode_longitude IS NULL)),
  CONSTRAINT mbt_customer_site_profiles_deposit_exception_reason
    CHECK (NOT deposit_exception OR NULLIF(btrim(deposit_exception_reason), '') IS NOT NULL),
  CONSTRAINT mbt_customer_site_profiles_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_customer_site_profiles_customer_address_unique
    UNIQUE (customer_netsuite_id, address_id)
);

CREATE INDEX IF NOT EXISTS idx_mbt_customer_site_profiles_active
  ON mbt_customer_site_profiles (customer_netsuite_id, active, address_id);

CREATE OR REPLACE FUNCTION netsuite_customer_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows must be retained and marked inactive', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_netsuite_customers_retain_history
  ON netsuite_customers;
CREATE TRIGGER trg_netsuite_customers_retain_history
  BEFORE DELETE ON netsuite_customers
  FOR EACH ROW EXECUTE FUNCTION netsuite_customer_reject_delete();

DROP TRIGGER IF EXISTS trg_netsuite_customer_subsidiaries_retain_history
  ON netsuite_customer_subsidiaries;
CREATE TRIGGER trg_netsuite_customer_subsidiaries_retain_history
  BEFORE DELETE ON netsuite_customer_subsidiaries
  FOR EACH ROW EXECUTE FUNCTION netsuite_customer_reject_delete();

DROP TRIGGER IF EXISTS trg_netsuite_customer_addresses_retain_history
  ON netsuite_customer_addresses;
CREATE TRIGGER trg_netsuite_customer_addresses_retain_history
  BEFORE DELETE ON netsuite_customer_addresses
  FOR EACH ROW EXECUTE FUNCTION netsuite_customer_reject_delete();

DROP TRIGGER IF EXISTS trg_netsuite_customer_contacts_retain_history
  ON netsuite_customer_contacts;
CREATE TRIGGER trg_netsuite_customer_contacts_retain_history
  BEFORE DELETE ON netsuite_customer_contacts
  FOR EACH ROW EXECUTE FUNCTION netsuite_customer_reject_delete();

COMMENT ON TABLE netsuite_customers IS
  'NetSuite-authoritative customer identity keyed only by NetSuite internal ID; raw NetSuite payloads are not retained.';

COMMENT ON TABLE netsuite_customer_sync_conflicts IS
  'Durable conflicts for equal-version/different-hash customer mirror input; resolution is explicit and revision guarded.';

COMMENT ON TABLE mbt_customer_site_profiles IS
  'Local operational site data that must never overwrite the NetSuite customer or address master.';
