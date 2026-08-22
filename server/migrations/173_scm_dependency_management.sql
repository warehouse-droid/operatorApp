-- Durable SCM dependency commands and explicit Driver route readiness.
-- All tables are additive. Existing Dispatch snapshots and Driver evidence are
-- not rewritten by this migration.

CREATE TABLE IF NOT EXISTS scm_dependency_action_receipts (
  request_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'executing',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id text NOT NULL DEFAULT '',
  surface text NOT NULL DEFAULT 'scm',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_dependency_receipt_payload_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT scm_dependency_receipt_action_not_blank
    CHECK (NULLIF(btrim(action), '') IS NOT NULL),
  CONSTRAINT scm_dependency_receipt_status
    CHECK (status IN ('executing', 'succeeded', 'failed')),
  CONSTRAINT scm_dependency_receipt_documents
    CHECK (jsonb_typeof(result) = 'object' AND jsonb_typeof(error) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_scm_dependency_receipts_recent
  ON scm_dependency_action_receipts (created_at DESC, request_id);

CREATE TABLE IF NOT EXISTS scm_dependency_change_requests (
  request_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_ref text NOT NULL,
  target_signature text NOT NULL DEFAULT '',
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  plan_date date,
  expected_plan_revision bigint,
  expected_plan_digest text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'waiting_driver',
  requested_by text NOT NULL DEFAULT '',
  requested_surface text NOT NULL DEFAULT 'scm',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  applied_at timestamptz,
  cancelled_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_dependency_change_payload_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT scm_dependency_change_target_not_blank
    CHECK (NULLIF(btrim(target_ref), '') IS NOT NULL),
  CONSTRAINT scm_dependency_change_action_not_blank
    CHECK (NULLIF(btrim(action), '') IS NOT NULL),
  CONSTRAINT scm_dependency_change_revision_nonnegative
    CHECK (expected_plan_revision IS NULL OR expected_plan_revision >= 0),
  CONSTRAINT scm_dependency_change_status
    CHECK (status IN ('waiting_driver', 'driver_ready', 'applied', 'cancelled', 'expired')),
  CONSTRAINT scm_dependency_change_result_object CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_scm_dependency_change_pending
  ON scm_dependency_change_requests (expires_at, created_at, request_id)
  WHERE status IN ('waiting_driver', 'driver_ready');
CREATE INDEX IF NOT EXISTS idx_scm_dependency_change_target
  ON scm_dependency_change_requests (lower(target_ref), created_at DESC);

CREATE TABLE IF NOT EXISTS scm_dependency_change_request_devices (
  request_id uuid NOT NULL
    REFERENCES scm_dependency_change_requests(request_id) ON DELETE CASCADE,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  manifest_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'waiting',
  readiness_token_hash text,
  ready_at timestamptz,
  ready_expires_at timestamptz,
  installed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, driver_login, device_id, manifest_id),
  CONSTRAINT scm_dependency_change_device_login_not_blank
    CHECK (NULLIF(btrim(driver_login), '') IS NOT NULL),
  CONSTRAINT scm_dependency_change_device_id_not_blank
    CHECK (NULLIF(btrim(device_id), '') IS NOT NULL),
  CONSTRAINT scm_dependency_change_device_state
    CHECK (state IN ('waiting', 'ready', 'installed', 'expired', 'cancelled')),
  CONSTRAINT scm_dependency_change_device_token_hash
    CHECK (readiness_token_hash IS NULL OR readiness_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_scm_dependency_change_device_driver
  ON scm_dependency_change_request_devices (lower(driver_login), device_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS driver_route_device_presence (
  driver_login text NOT NULL,
  device_id text NOT NULL,
  session_id uuid REFERENCES driver_sessions(session_id) ON DELETE SET NULL,
  visible boolean NOT NULL DEFAULT false,
  online boolean NOT NULL DEFAULT false,
  manifest_id uuid,
  plan_id bigint REFERENCES dispatch_plans(id) ON DELETE SET NULL,
  plan_date date,
  plan_revision bigint NOT NULL DEFAULT 0,
  sync_state text NOT NULL DEFAULT 'unknown',
  pending_event_count integer NOT NULL DEFAULT 0,
  pending_photo_count integer NOT NULL DEFAULT 0,
  active_job_id text NOT NULL DEFAULT '',
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_login, device_id),
  CONSTRAINT driver_route_presence_login_not_blank
    CHECK (NULLIF(btrim(driver_login), '') IS NOT NULL),
  CONSTRAINT driver_route_presence_device_not_blank
    CHECK (NULLIF(btrim(device_id), '') IS NOT NULL),
  CONSTRAINT driver_route_presence_revision_nonnegative CHECK (plan_revision >= 0),
  CONSTRAINT driver_route_presence_pending_nonnegative
    CHECK (pending_event_count >= 0 AND pending_photo_count >= 0),
  CONSTRAINT driver_route_presence_sync_state
    CHECK (sync_state IN ('unknown', 'clean', 'pending', 'review'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_route_presence_identity_ci
  ON driver_route_device_presence (lower(driver_login), device_id);
CREATE INDEX IF NOT EXISTS idx_driver_route_presence_plan
  ON driver_route_device_presence (plan_id, plan_date, heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_route_presence_driver_recent
  ON driver_route_device_presence (lower(driver_login), heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS driver_push_subscriptions (
  id bigserial PRIMARY KEY,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT driver_push_subscription_login_not_blank
    CHECK (NULLIF(btrim(driver_login), '') IS NOT NULL),
  CONSTRAINT driver_push_subscription_device_not_blank
    CHECK (NULLIF(btrim(device_id), '') IS NOT NULL),
  CONSTRAINT driver_push_subscription_endpoint_not_blank
    CHECK (NULLIF(btrim(endpoint), '') IS NOT NULL),
  CONSTRAINT driver_push_subscription_keys_not_blank
    CHECK (NULLIF(btrim(p256dh), '') IS NOT NULL AND NULLIF(btrim(auth_secret), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_driver_push_subscription_active_driver
  ON driver_push_subscriptions (lower(driver_login), device_id, updated_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE driver_offline_manifests
  ADD COLUMN IF NOT EXISTS superseded_by_request_id uuid
    REFERENCES scm_dependency_change_requests(request_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_reason text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_driver_offline_manifest_active_plan
  ON driver_offline_manifests (plan_id, plan_date, lower(driver_login), device_id)
  WHERE superseded_at IS NULL;
