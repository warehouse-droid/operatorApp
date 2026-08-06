-- MBT Phase 1 authority, capability, command-idempotency, and audit
-- foundations. Operational capabilities are deliberately seeded disabled.

ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_role_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_role_check
  CHECK (
    role IN (
      'operator',
      'dispatcher',
      'admin',
      'scm',
      'yard_manager',
      'sales',
      'mbt_frontdesk',
      'mbt_billing'
    )
  );

ALTER TABLE operators
  DROP CONSTRAINT IF EXISTS operators_roles_allowed_check;

ALTER TABLE operators
  ADD CONSTRAINT operators_roles_allowed_check
  CHECK (
    cardinality(roles) > 0
    AND roles <@ ARRAY[
      'operator',
      'dispatcher',
      'admin',
      'scm',
      'yard_manager',
      'sales',
      'mbt_frontdesk',
      'mbt_billing'
    ]::text[]
    AND role = ANY(roles)
  );

CREATE TABLE IF NOT EXISTS mbt_feature_flags (
  flag_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  description text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 1,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_feature_flags_key_not_blank
    CHECK (NULLIF(btrim(flag_key), '') IS NOT NULL),
  CONSTRAINT mbt_feature_flags_key_format
    CHECK (flag_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT mbt_feature_flags_revision_positive
    CHECK (revision > 0)
);

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES
  ('mbt_enabled', false, 'Global MBT domain capability'),
  ('mbt_frontdesk_operations', false, 'MBT Front Desk operational commands'),
  ('mbt_billing_operations', false, 'MBT billing operational commands'),
  ('mbt_bin_dispatch', false, 'Dispatch BIN save, restore, and confirmation'),
  ('mbt_driver_execution', false, 'Driver PWA BIN materialization and execution'),
  ('mbt_netsuite_writes', false, 'Operational MBT NetSuite writes')
ON CONFLICT (flag_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS mbt_command_receipts (
  receipt_id uuid PRIMARY KEY,
  actor_operator_id text NOT NULL,
  actor_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  command_name text NOT NULL,
  idempotency_key text NOT NULL,
  canonical_payload_hash text NOT NULL,
  http_status integer NOT NULL,
  response_body jsonb NOT NULL,
  entity_type text,
  entity_id text,
  correlation_id text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_command_receipts_actor_not_blank
    CHECK (NULLIF(btrim(actor_operator_id), '') IS NOT NULL),
  CONSTRAINT mbt_command_receipts_command_not_blank
    CHECK (NULLIF(btrim(command_name), '') IS NOT NULL),
  CONSTRAINT mbt_command_receipts_key_not_blank
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL),
  CONSTRAINT mbt_command_receipts_payload_hash_sha256
    CHECK (canonical_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_command_receipts_http_status
    CHECK (http_status BETWEEN 100 AND 599),
  CONSTRAINT mbt_command_receipts_response_json
    CHECK (jsonb_typeof(response_body) = 'object'),
  CONSTRAINT mbt_command_receipts_correlation_not_blank
    CHECK (NULLIF(btrim(correlation_id), '') IS NOT NULL),
  CONSTRAINT mbt_command_receipts_request_not_blank
    CHECK (NULLIF(btrim(request_id), '') IS NOT NULL),
  CONSTRAINT mbt_command_receipts_actor_command_key_unique
    UNIQUE (actor_operator_id, command_name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mbt_command_receipts_created
  ON mbt_command_receipts (created_at DESC, receipt_id);

CREATE TABLE IF NOT EXISTS mbt_audit_events (
  audit_event_id uuid PRIMARY KEY,
  actor_type text NOT NULL DEFAULT 'operator',
  actor_operator_id text NOT NULL,
  actor_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reason text NOT NULL,
  revision_before bigint NOT NULL,
  revision_after bigint NOT NULL,
  correlation_id text NOT NULL,
  request_id text NOT NULL,
  idempotency_key text NOT NULL,
  source text NOT NULL DEFAULT 'mbt',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_audit_events_actor_type_not_blank
    CHECK (NULLIF(btrim(actor_type), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_actor_not_blank
    CHECK (NULLIF(btrim(actor_operator_id), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_roles_not_empty
    CHECK (cardinality(actor_roles) > 0),
  CONSTRAINT mbt_audit_events_action_not_blank
    CHECK (NULLIF(btrim(action), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_entity_type_not_blank
    CHECK (NULLIF(btrim(entity_type), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_entity_id_not_blank
    CHECK (NULLIF(btrim(entity_id), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_reason_not_blank
    CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_before_json
    CHECK (before_state IS NULL OR jsonb_typeof(before_state) = 'object'),
  CONSTRAINT mbt_audit_events_after_json
    CHECK (after_state IS NULL OR jsonb_typeof(after_state) = 'object'),
  CONSTRAINT mbt_audit_events_revision_before_positive
    CHECK (revision_before IS NULL OR revision_before > 0),
  CONSTRAINT mbt_audit_events_revision_after_positive
    CHECK (revision_after IS NULL OR revision_after > 0),
  CONSTRAINT mbt_audit_events_revision_order
    CHECK (
      revision_before IS NULL
      OR revision_after IS NULL
      OR revision_after >= revision_before
    ),
  CONSTRAINT mbt_audit_events_correlation_not_blank
    CHECK (NULLIF(btrim(correlation_id), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_request_not_blank
    CHECK (NULLIF(btrim(request_id), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_idempotency_not_blank
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL),
  CONSTRAINT mbt_audit_events_source_not_blank
    CHECK (NULLIF(btrim(source), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_mbt_audit_events_entity
  ON mbt_audit_events (entity_type, entity_id, occurred_at DESC, audit_event_id);

CREATE INDEX IF NOT EXISTS idx_mbt_audit_events_actor
  ON mbt_audit_events (actor_operator_id, occurred_at DESC, audit_event_id)
  WHERE actor_operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mbt_audit_events_correlation
  ON mbt_audit_events (correlation_id, occurred_at, audit_event_id);

CREATE OR REPLACE FUNCTION mbt_reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_command_receipts_immutable
  ON mbt_command_receipts;
CREATE TRIGGER trg_mbt_command_receipts_immutable
  BEFORE UPDATE OR DELETE ON mbt_command_receipts
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

DROP TRIGGER IF EXISTS trg_mbt_audit_events_immutable
  ON mbt_audit_events;
CREATE TRIGGER trg_mbt_audit_events_immutable
  BEFORE UPDATE OR DELETE ON mbt_audit_events
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

COMMENT ON TABLE mbt_feature_flags IS
  'Fail-closed database capabilities for the MBT domain; every Phase 1 operational flag is seeded false.';

COMMENT ON TABLE mbt_command_receipts IS
  'Immutable successful-command receipts used for exact idempotent replay by actor, command, and key.';

COMMENT ON TABLE mbt_audit_events IS
  'Redacted, append-only privileged MBT mutation audit evidence.';
