-- MBT Phase 3 bounded import evidence and the independently versioned
-- customer-master/v1 durability layer. This migration stores normalized
-- evidence only: it does not import a file, synchronize a customer, alter the
-- Returns directory, call NetSuite, or enable any Phase 3 capability.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS mbt_import_batches (
  batch_id uuid PRIMARY KEY,
  resource_kind text NOT NULL,
  source_kind text NOT NULL,
  source_account_id text NOT NULL,
  source_filename text NOT NULL DEFAULT '',
  schema_version text NOT NULL,
  file_hash text NOT NULL,
  normalized_hash text NOT NULL,
  target_revision_token text NOT NULL,
  status text NOT NULL DEFAULT 'previewed',
  actor_operator_id text NOT NULL,
  applied_idempotency_key text,
  apply_reason text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  safe_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  previewed_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_import_batches_resource
    CHECK (resource_kind IN (
      'customers', 'local_items', 'materials', 'dump_sites', 'bin_assets',
      'rate_cards'
    )),
  CONSTRAINT mbt_import_batches_source
    CHECK (source_kind IN (
      'netsuite_spreadsheetml', 'customer_csv', 'csv', 'manual'
    )),
  CONSTRAINT mbt_import_batches_source_account_not_blank
    CHECK (NULLIF(btrim(source_account_id), '') IS NOT NULL),
  CONSTRAINT mbt_import_batches_schema_not_blank
    CHECK (NULLIF(btrim(schema_version), '') IS NOT NULL),
  CONSTRAINT mbt_import_batches_file_hash_sha256
    CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_import_batches_normalized_hash_sha256
    CHECK (normalized_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_import_batches_revision_hash_sha256
    CHECK (target_revision_token ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_import_batches_status
    CHECK (status IN (
      'previewed', 'applying', 'applied', 'failed', 'conflicted', 'expired'
    )),
  CONSTRAINT mbt_import_batches_actor_not_blank
    CHECK (NULLIF(btrim(actor_operator_id), '') IS NOT NULL),
  CONSTRAINT mbt_import_batches_idempotency_key_not_blank
    CHECK (
      applied_idempotency_key IS NULL
      OR NULLIF(btrim(applied_idempotency_key), '') IS NOT NULL
    ),
  CONSTRAINT mbt_import_batches_apply_reason_not_blank
    CHECK (apply_reason IS NULL OR NULLIF(btrim(apply_reason), '') IS NOT NULL),
  CONSTRAINT mbt_import_batches_json_shapes
    CHECK (
      jsonb_typeof(summary) = 'object'
      AND jsonb_typeof(warnings) = 'array'
      AND jsonb_typeof(safe_errors) = 'array'
      AND jsonb_typeof(safe_metadata) = 'object'
    ),
  CONSTRAINT mbt_import_batches_revision_positive CHECK (revision > 0),
  CONSTRAINT mbt_import_batches_expiry_order CHECK (expires_at > previewed_at),
  CONSTRAINT mbt_import_batches_apply_state
    CHECK (
      (status = 'applied' AND applied_at IS NOT NULL
        AND applied_idempotency_key IS NOT NULL AND apply_reason IS NOT NULL)
      OR status <> 'applied'
    )
);

CREATE INDEX IF NOT EXISTS idx_mbt_import_batches_work
  ON mbt_import_batches (resource_kind, status, previewed_at DESC, batch_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_import_batches_idempotency_binding
  ON mbt_import_batches (actor_operator_id, applied_idempotency_key)
  WHERE applied_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS mbt_import_staged_rows (
  batch_id uuid NOT NULL REFERENCES mbt_import_batches(batch_id) ON DELETE RESTRICT,
  row_number integer NOT NULL,
  natural_key text NOT NULL,
  normalized_payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  expected_target_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, row_number),
  CONSTRAINT mbt_import_staged_rows_row_positive CHECK (row_number > 0),
  CONSTRAINT mbt_import_staged_rows_natural_key_not_blank
    CHECK (NULLIF(btrim(natural_key), '') IS NOT NULL),
  CONSTRAINT mbt_import_staged_rows_payload_object
    CHECK (jsonb_typeof(normalized_payload) = 'object'),
  CONSTRAINT mbt_import_staged_rows_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_import_staged_rows_revision_positive
    CHECK (expected_target_revision IS NULL OR expected_target_revision > 0),
  CONSTRAINT mbt_import_staged_rows_batch_key_unique UNIQUE (batch_id, natural_key)
);

CREATE INDEX IF NOT EXISTS idx_mbt_import_staged_rows_key
  ON mbt_import_staged_rows (natural_key, batch_id, row_number);

CREATE TABLE IF NOT EXISTS mbt_import_row_errors (
  batch_id uuid NOT NULL REFERENCES mbt_import_batches(batch_id) ON DELETE RESTRICT,
  error_sequence integer NOT NULL,
  row_number integer,
  error_code text NOT NULL,
  field_name text,
  safe_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, error_sequence),
  CONSTRAINT mbt_import_row_errors_sequence_positive CHECK (error_sequence > 0),
  CONSTRAINT mbt_import_row_errors_row_positive
    CHECK (row_number IS NULL OR row_number > 0),
  CONSTRAINT mbt_import_row_errors_code_not_blank
    CHECK (NULLIF(btrim(error_code), '') IS NOT NULL),
  CONSTRAINT mbt_import_row_errors_message_not_blank
    CHECK (NULLIF(btrim(safe_message), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS mbt_import_apply_results (
  apply_result_id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES mbt_import_batches(batch_id) ON DELETE RESTRICT,
  row_number integer NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  source_kind text NOT NULL,
  source_account_id text NOT NULL,
  source_version text NOT NULL,
  entity_revision bigint,
  payload_hash text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_import_apply_results_row_positive CHECK (row_number > 0),
  CONSTRAINT mbt_import_apply_results_entity_type_not_blank
    CHECK (NULLIF(btrim(entity_type), '') IS NOT NULL),
  CONSTRAINT mbt_import_apply_results_entity_id_not_blank
    CHECK (NULLIF(btrim(entity_id), '') IS NOT NULL),
  CONSTRAINT mbt_import_apply_results_action
    CHECK (action IN ('created', 'updated', 'unchanged', 'conflicted')),
  CONSTRAINT mbt_import_apply_results_source
    CHECK (source_kind IN (
      'netsuite_read', 'customer_master_event', 'csv_bootstrap', 'manual'
    )),
  CONSTRAINT mbt_import_apply_results_source_account_not_blank
    CHECK (NULLIF(btrim(source_account_id), '') IS NOT NULL),
  CONSTRAINT mbt_import_apply_results_source_version_not_blank
    CHECK (NULLIF(btrim(source_version), '') IS NOT NULL),
  CONSTRAINT mbt_import_apply_results_revision_positive
    CHECK (entity_revision IS NULL OR entity_revision > 0),
  CONSTRAINT mbt_import_apply_results_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_import_apply_results_batch_row_unique UNIQUE (batch_id, row_number),
  CONSTRAINT mbt_import_apply_results_batch_entity_unique UNIQUE (batch_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_mbt_import_apply_results_entity
  ON mbt_import_apply_results (entity_type, entity_id, applied_at, apply_result_id);

CREATE TABLE IF NOT EXISTS mbt_customer_provenance (
  customer_netsuite_id bigint PRIMARY KEY
    REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  source_kind text NOT NULL,
  source_account_id text NOT NULL,
  source_version text NOT NULL,
  payload_hash text NOT NULL,
  last_live_netsuite_observation_at timestamptz,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_customer_provenance_customer_positive
    CHECK (customer_netsuite_id > 0),
  CONSTRAINT mbt_customer_provenance_source
    CHECK (source_kind IN (
      'netsuite_read', 'customer_master_event', 'csv_bootstrap'
    )),
  CONSTRAINT mbt_customer_provenance_account_not_blank
    CHECK (NULLIF(btrim(source_account_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_provenance_version_not_blank
    CHECK (NULLIF(btrim(source_version), '') IS NOT NULL),
  CONSTRAINT mbt_customer_provenance_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_customer_provenance_live_observation
    CHECK (
      source_kind <> 'netsuite_read'
      OR last_live_netsuite_observation_at IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_mbt_customer_provenance_source
  ON mbt_customer_provenance (source_account_id, source_kind, customer_netsuite_id);

CREATE TABLE IF NOT EXISTS mbt_customer_master_events (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uuid uuid NOT NULL UNIQUE,
  account_id text NOT NULL,
  subsidiary_id bigint,
  customer_netsuite_id bigint NOT NULL
    REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  change_type text NOT NULL,
  source_kind text NOT NULL,
  source_version text NOT NULL,
  payload_hash text NOT NULL,
  aggregate_payload jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT mbt_customer_master_events_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_events_subsidiary_positive
    CHECK (subsidiary_id IS NULL OR subsidiary_id > 0),
  CONSTRAINT mbt_customer_master_events_customer_positive
    CHECK (customer_netsuite_id > 0),
  CONSTRAINT mbt_customer_master_events_change
    CHECK (change_type IN ('upsert', 'inactivate')),
  CONSTRAINT mbt_customer_master_events_source
    CHECK (source_kind IN (
      'netsuite_read', 'customer_master_event', 'csv_bootstrap'
    )),
  CONSTRAINT mbt_customer_master_events_version_not_blank
    CHECK (NULLIF(btrim(source_version), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_events_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_customer_master_events_payload_object
    CHECK (jsonb_typeof(aggregate_payload) = 'object'),
  CONSTRAINT mbt_customer_master_events_observation_unique
    UNIQUE (customer_netsuite_id, source_kind, source_version, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_mbt_customer_master_events_delivery
  ON mbt_customer_master_events (sequence_id, customer_netsuite_id);

CREATE TABLE IF NOT EXISTS mbt_customer_master_inbox (
  consumer_id text NOT NULL,
  event_uuid uuid NOT NULL,
  source_sequence bigint NOT NULL,
  account_id text NOT NULL,
  subsidiary_id bigint,
  envelope_hash text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_id, event_uuid),
  CONSTRAINT mbt_customer_master_inbox_consumer_not_blank
    CHECK (NULLIF(btrim(consumer_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_inbox_sequence_positive CHECK (source_sequence > 0),
  CONSTRAINT mbt_customer_master_inbox_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_inbox_subsidiary_positive
    CHECK (subsidiary_id IS NULL OR subsidiary_id > 0),
  CONSTRAINT mbt_customer_master_inbox_hash_sha256
    CHECK (envelope_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_customer_master_inbox_consumer_sequence_unique
    UNIQUE (consumer_id, account_id, subsidiary_id, source_sequence)
);

CREATE TABLE IF NOT EXISTS mbt_customer_master_consumer_state (
  consumer_id text NOT NULL,
  account_id text NOT NULL,
  subsidiary_key bigint NOT NULL DEFAULT 0,
  high_water_sequence bigint NOT NULL DEFAULT 0,
  last_complete_snapshot_id uuid,
  revision bigint NOT NULL DEFAULT 1,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, account_id, subsidiary_key),
  CONSTRAINT mbt_customer_master_consumer_state_consumer_not_blank
    CHECK (NULLIF(btrim(consumer_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_consumer_state_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_consumer_state_subsidiary_nonnegative
    CHECK (subsidiary_key >= 0),
  CONSTRAINT mbt_customer_master_consumer_state_sequence_nonnegative
    CHECK (high_water_sequence >= 0),
  CONSTRAINT mbt_customer_master_consumer_state_revision_positive
    CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS mbt_customer_master_snapshot_pages (
  consumer_id text NOT NULL,
  snapshot_id uuid NOT NULL,
  page_cursor text NOT NULL,
  account_id text NOT NULL,
  subsidiary_id bigint,
  page_hash text NOT NULL,
  record_count integer NOT NULL,
  complete boolean NOT NULL DEFAULT false,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_id, snapshot_id, page_cursor),
  CONSTRAINT mbt_customer_master_snapshot_pages_consumer_not_blank
    CHECK (NULLIF(btrim(consumer_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_snapshot_pages_cursor_not_blank
    CHECK (NULLIF(btrim(page_cursor), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_snapshot_pages_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_master_snapshot_pages_subsidiary_positive
    CHECK (subsidiary_id IS NULL OR subsidiary_id > 0),
  CONSTRAINT mbt_customer_master_snapshot_pages_hash_sha256
    CHECK (page_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_customer_master_snapshot_pages_record_count
    CHECK (record_count >= 0)
);

CREATE TABLE IF NOT EXISTS mbt_customer_returns_projection_runs (
  generation_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  subsidiary_id bigint,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  canonical_active_count integer NOT NULL,
  projected_count integer NOT NULL,
  canonical_hash text NOT NULL,
  projection_hash text NOT NULL,
  actor_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT mbt_customer_returns_projection_account_not_blank
    CHECK (NULLIF(btrim(account_id), '') IS NOT NULL),
  CONSTRAINT mbt_customer_returns_projection_subsidiary_positive
    CHECK (subsidiary_id IS NULL OR subsidiary_id > 0),
  CONSTRAINT mbt_customer_returns_projection_source_not_blank
    CHECK (NULLIF(btrim(source), '') IS NOT NULL),
  CONSTRAINT mbt_customer_returns_projection_status
    CHECK (status IN ('completed', 'failed')),
  CONSTRAINT mbt_customer_returns_projection_counts
    CHECK (canonical_active_count >= 0 AND projected_count >= 0),
  CONSTRAINT mbt_customer_returns_projection_canonical_hash
    CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_customer_returns_projection_projection_hash
    CHECK (projection_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_customer_returns_projection_actor_not_blank
    CHECK (NULLIF(btrim(actor_id), '') IS NOT NULL)
);

COMMENT ON TABLE mbt_import_batches IS
  'Aggregate-only import decisions and hashes; raw uploaded files are never retained.';

COMMENT ON TABLE mbt_import_staged_rows IS
  'Bounded normalized staging rows retained temporarily for exact preview/apply; never exposed by public batch responses.';

COMMENT ON TABLE mbt_customer_master_events IS
  'Independent durable customer-master/v1 event stream; netsuite-mirror/v1 is intentionally unchanged.';

COMMENT ON TABLE mbt_customer_provenance IS
  'Current canonical customer source ownership and the first/last live NetSuite observation boundary.';
