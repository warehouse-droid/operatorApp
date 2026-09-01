CREATE TABLE IF NOT EXISTS netsuite_order_webhook_inbox (
  id bigserial PRIMARY KEY,
  entity_key text NOT NULL,
  record_type text NOT NULL,
  netsuite_order_id text NOT NULL,
  event_type text NOT NULL DEFAULT '',
  source_modified_at timestamptz,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  raw_body text NOT NULL,
  received_bytes integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  superseded_by_id bigint REFERENCES netsuite_order_webhook_inbox(id),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  app_notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_order_webhook_record_type_check
    CHECK (record_type IN ('sales_order', 'purchase_order', 'transfer_order')),
  CONSTRAINT netsuite_order_webhook_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'superseded')),
  CONSTRAINT netsuite_order_webhook_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT netsuite_order_webhook_result_object_check
    CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT netsuite_order_webhook_attempt_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT netsuite_order_webhook_received_bytes_nonnegative CHECK (received_bytes >= 0),
  UNIQUE (entity_key, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_netsuite_order_webhook_claim
  ON netsuite_order_webhook_inbox (available_at, received_at, id)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_netsuite_order_webhook_expired_lease
  ON netsuite_order_webhook_inbox (lease_expires_at, id)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_netsuite_order_webhook_entity_version
  ON netsuite_order_webhook_inbox (
    entity_key,
    source_modified_at DESC NULLS LAST,
    received_at DESC,
    id DESC
  );
CREATE INDEX IF NOT EXISTS idx_netsuite_order_webhook_status_recent
  ON netsuite_order_webhook_inbox (status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_netsuite_order_webhook_app_notification
  ON netsuite_order_webhook_inbox (completed_at, id)
  WHERE status = 'succeeded' AND app_notified_at IS NULL;

CREATE TABLE IF NOT EXISTS netsuite_order_webhook_attempts (
  id bigserial PRIMARY KEY,
  inbox_id bigint NOT NULL REFERENCES netsuite_order_webhook_inbox(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  worker_id text NOT NULL,
  lease_token uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'running',
  error text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT netsuite_order_webhook_attempt_outcome_check
    CHECK (outcome IN ('running', 'succeeded', 'failed', 'lease_expired')),
  CONSTRAINT netsuite_order_webhook_attempt_details_object_check
    CHECK (jsonb_typeof(details) = 'object'),
  UNIQUE (inbox_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_netsuite_order_webhook_attempt_recent
  ON netsuite_order_webhook_attempts (started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS netsuite_order_webhook_control (
  singleton boolean PRIMARY KEY DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  pause_reason text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT netsuite_order_webhook_control_singleton CHECK (singleton)
);

INSERT INTO netsuite_order_webhook_control (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS scm_purchase_order_catalog_entries (
  order_ref text PRIMARY KEY,
  order_kind text NOT NULL DEFAULT 'po',
  eligible boolean NOT NULL DEFAULT true,
  source_updated_at timestamptz,
  activity_at timestamptz NOT NULL DEFAULT now(),
  search_text text NOT NULL DEFAULT '',
  dropoff_key text NOT NULL DEFAULT '',
  vendor_key text NOT NULL DEFAULT '',
  pickup_key text NOT NULL DEFAULT '',
  linked_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL,
  detail jsonb NOT NULL,
  source text NOT NULL DEFAULT '',
  catalog_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_purchase_order_catalog_kind_check CHECK (order_kind IN ('po', 'split')),
  CONSTRAINT scm_purchase_order_catalog_linked_refs_array CHECK (jsonb_typeof(linked_refs) = 'array'),
  CONSTRAINT scm_purchase_order_catalog_summary_object CHECK (jsonb_typeof(summary) = 'object'),
  CONSTRAINT scm_purchase_order_catalog_detail_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_purchase_order_catalog_ref_ci
  ON scm_purchase_order_catalog_entries (lower(order_ref));
CREATE INDEX IF NOT EXISTS idx_scm_purchase_order_catalog_recent
  ON scm_purchase_order_catalog_entries (eligible, activity_at DESC, lower(order_ref));
CREATE INDEX IF NOT EXISTS idx_scm_purchase_order_catalog_kind_recent
  ON scm_purchase_order_catalog_entries (order_kind, eligible, activity_at DESC, lower(order_ref));
CREATE INDEX IF NOT EXISTS idx_scm_purchase_order_catalog_dropoff
  ON scm_purchase_order_catalog_entries (dropoff_key, activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_scm_purchase_order_catalog_vendor
  ON scm_purchase_order_catalog_entries (vendor_key, activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_scm_purchase_order_catalog_pickup
  ON scm_purchase_order_catalog_entries (pickup_key, activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_scm_purchase_order_catalog_search_trgm
  ON scm_purchase_order_catalog_entries USING gin (search_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS scm_purchase_order_catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  status text NOT NULL DEFAULT 'warming',
  generation bigint NOT NULL DEFAULT 0,
  catalog_count integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT '',
  last_full_refresh_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_purchase_order_catalog_state_singleton CHECK (singleton),
  CONSTRAINT scm_purchase_order_catalog_state_status CHECK (status IN ('warming', 'ready', 'failed'))
);

INSERT INTO scm_purchase_order_catalog_state (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS scm_purchase_order_catalog_refresh_outbox (
  id bigserial PRIMARY KEY,
  order_ref text,
  source text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT scm_purchase_order_catalog_refresh_status
    CHECK (status IN ('pending', 'running', 'failed', 'complete'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_purchase_order_catalog_refresh_active
  ON scm_purchase_order_catalog_refresh_outbox (COALESCE(lower(order_ref), ''))
  WHERE status IN ('pending', 'running', 'failed');
CREATE INDEX IF NOT EXISTS idx_scm_purchase_order_catalog_refresh_claim
  ON scm_purchase_order_catalog_refresh_outbox (available_at, id)
  WHERE status IN ('pending', 'failed');

ALTER TABLE dispatch_order_catalog_entries
  ADD COLUMN IF NOT EXISTS activity_at timestamptz;

UPDATE dispatch_order_catalog_entries
   SET activity_at = COALESCE(source_updated_at, updated_at, now())
 WHERE activity_at IS NULL;

ALTER TABLE dispatch_order_catalog_entries
  ALTER COLUMN activity_at SET DEFAULT now(),
  ALTER COLUMN activity_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_order_catalog_recent
  ON dispatch_order_catalog_entries (eligible, order_type, activity_at DESC, lower(order_ref));

CREATE INDEX IF NOT EXISTS idx_dispatch_plans_history_summary
  ON dispatch_plans (plan_date DESC, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS dispatch_plan_projection_state (
  plan_id bigint PRIMARY KEY REFERENCES dispatch_plans(id) ON DELETE CASCADE,
  source_revision bigint NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_plan_projection_revision_nonnegative CHECK (source_revision >= 0)
);

UPDATE dispatch_order_catalog_state
   SET assignments_ready = false,
       status = CASE WHEN status = 'ready' THEN 'warming' ELSE status END,
       updated_at = now()
 WHERE singleton = true;
