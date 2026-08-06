-- MBT Phase 3.9 Driver-PWA BIN execution evidence.
--
-- All structures are additive and inert while mbt_driver_execution remains
-- disabled. No legacy Driver, Dispatch, Operator, SCM, posting, or transport
-- table is rewritten by this migration.

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS mbt_driver_pilot_scope (
  pilot_scope_id uuid PRIMARY KEY,
  plan_date date NOT NULL,
  driver_login text NOT NULL,
  truck_id bigint NOT NULL REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  service_visit_id uuid NOT NULL REFERENCES mbt_service_visits(service_visit_id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_driver_pilot_scope_driver_not_blank
    CHECK (NULLIF(btrim(driver_login), '') IS NOT NULL),
  CONSTRAINT mbt_driver_pilot_scope_actor_not_blank
    CHECK (NULLIF(btrim(authorized_by), '') IS NOT NULL),
  CONSTRAINT mbt_driver_pilot_scope_expiry_order
    CHECK (expires_at > authorized_at),
  CONSTRAINT mbt_driver_pilot_scope_revocation_complete
    CHECK (
      (revoked_at IS NULL AND revoke_reason IS NULL)
      OR
      (revoked_at IS NOT NULL AND NULLIF(btrim(COALESCE(revoke_reason, '')), '') IS NOT NULL)
    ),
  CONSTRAINT mbt_driver_pilot_scope_visit_unique
    UNIQUE (service_visit_id, driver_login, plan_date)
);

CREATE INDEX IF NOT EXISTS idx_mbt_driver_pilot_scope_lookup
  ON mbt_driver_pilot_scope (plan_date, lower(driver_login), truck_id, active)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mbt_driver_bin_event_applications (
  application_id uuid PRIMARY KEY,
  source_event_id uuid NOT NULL UNIQUE,
  manifest_id uuid NOT NULL,
  client_sequence bigint NOT NULL,
  event_type text NOT NULL,
  driver_login text NOT NULL,
  device_id text NOT NULL,
  job_id text NOT NULL,
  service_visit_id uuid NOT NULL REFERENCES mbt_service_visits(service_visit_id) ON DELETE RESTRICT,
  visit_step_id uuid NOT NULL REFERENCES mbt_visit_steps(visit_step_id) ON DELETE RESTRICT,
  action_code text NOT NULL,
  execution_snapshot_hash text NOT NULL,
  immutable_payload_hash text NOT NULL,
  device_occurred_at timestamptz NOT NULL,
  server_received_at timestamptz NOT NULL,
  server_applied_at timestamptz NOT NULL DEFAULT now(),
  application_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_driver_bin_application_event_type
    CHECK (event_type IN ('job_started', 'job_completed')),
  CONSTRAINT mbt_driver_bin_application_sequence_positive
    CHECK (client_sequence > 0),
  CONSTRAINT mbt_driver_bin_application_driver_not_blank
    CHECK (NULLIF(btrim(driver_login), '') IS NOT NULL),
  CONSTRAINT mbt_driver_bin_application_device_not_blank
    CHECK (NULLIF(btrim(device_id), '') IS NOT NULL),
  CONSTRAINT mbt_driver_bin_application_job_not_blank
    CHECK (NULLIF(btrim(job_id), '') IS NOT NULL),
  CONSTRAINT mbt_driver_bin_application_action_format
    CHECK (action_code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT mbt_driver_bin_application_snapshot_hash
    CHECK (execution_snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_driver_bin_application_payload_hash
    CHECK (immutable_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_driver_bin_application_result_object
    CHECK (jsonb_typeof(application_result) = 'object'),
  CONSTRAINT mbt_driver_bin_application_times
    CHECK (
      server_received_at >= device_occurred_at
      AND server_applied_at >= server_received_at
    ),
  CONSTRAINT mbt_driver_bin_application_job_event_unique
    UNIQUE (job_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_mbt_driver_bin_application_visit
  ON mbt_driver_bin_event_applications
    (service_visit_id, client_sequence, server_applied_at, application_id);

ALTER TABLE mbt_evidence
  ADD COLUMN IF NOT EXISTS source_driver_event_id uuid,
  ADD COLUMN IF NOT EXISTS evidence_code text,
  ADD COLUMN IF NOT EXISTS asset_role text,
  ADD COLUMN IF NOT EXISTS source_ordinal integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mbt_evidence_driver_code_format'
       AND conrelid = 'mbt_evidence'::regclass
  ) THEN
    ALTER TABLE mbt_evidence
      ADD CONSTRAINT mbt_evidence_driver_code_format
      CHECK (evidence_code IS NULL OR evidence_code ~ '^[a-z][a-z0-9_]*$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mbt_evidence_driver_asset_role'
       AND conrelid = 'mbt_evidence'::regclass
  ) THEN
    ALTER TABLE mbt_evidence
      ADD CONSTRAINT mbt_evidence_driver_asset_role
      CHECK (asset_role IS NULL OR asset_role IN ('expected', 'outgoing', 'incoming'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mbt_evidence_driver_ordinal_nonnegative'
       AND conrelid = 'mbt_evidence'::regclass
  ) THEN
    ALTER TABLE mbt_evidence
      ADD CONSTRAINT mbt_evidence_driver_ordinal_nonnegative
      CHECK (source_ordinal IS NULL OR source_ordinal >= 0);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_evidence_driver_event_identity
  ON mbt_evidence (
    source_driver_event_id,
    COALESCE(evidence_code, ''),
    COALESCE(asset_role, ''),
    COALESCE(source_ordinal, -1)
  )
  WHERE source_driver_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mbt_dump_receipts (
  dump_receipt_id uuid PRIMARY KEY,
  source_driver_event_id uuid NOT NULL UNIQUE,
  service_visit_id uuid NOT NULL REFERENCES mbt_service_visits(service_visit_id) ON DELETE RESTRICT,
  visit_step_id uuid NOT NULL REFERENCES mbt_visit_steps(visit_step_id) ON DELETE RESTRICT,
  dump_site_id uuid NOT NULL REFERENCES mbt_dump_sites(dump_site_id) ON DELETE RESTRICT,
  material_id uuid NOT NULL REFERENCES mbt_materials(material_id) ON DELETE RESTRICT,
  ticket_number text NOT NULL,
  weight numeric(18, 6),
  quantity numeric(18, 6),
  unit_of_measure text NOT NULL,
  subtotal_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  receipt_photo_evidence_id uuid NOT NULL REFERENCES mbt_evidence(evidence_id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL,
  server_received_at timestamptz NOT NULL,
  recorded_by_driver_login text NOT NULL,
  receipt_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_dump_receipts_ticket_not_blank
    CHECK (NULLIF(btrim(ticket_number), '') IS NOT NULL),
  CONSTRAINT mbt_dump_receipts_measurement_nonnegative
    CHECK (
      (weight IS NULL OR weight >= 0)
      AND (quantity IS NULL OR quantity >= 0)
      AND (weight IS NOT NULL OR quantity IS NOT NULL)
    ),
  CONSTRAINT mbt_dump_receipts_uom_not_blank
    CHECK (NULLIF(btrim(unit_of_measure), '') IS NOT NULL),
  CONSTRAINT mbt_dump_receipts_money_exact
    CHECK (
      subtotal_minor >= 0
      AND tax_minor >= 0
      AND total_minor = subtotal_minor + tax_minor
    ),
  CONSTRAINT mbt_dump_receipts_currency
    CHECK (currency = 'CAD'),
  CONSTRAINT mbt_dump_receipts_driver_not_blank
    CHECK (NULLIF(btrim(recorded_by_driver_login), '') IS NOT NULL),
  CONSTRAINT mbt_dump_receipts_snapshot_object
    CHECK (jsonb_typeof(receipt_snapshot) = 'object'),
  CONSTRAINT mbt_dump_receipts_time_order
    CHECK (server_received_at >= captured_at)
);

CREATE INDEX IF NOT EXISTS idx_mbt_dump_receipts_visit
  ON mbt_dump_receipts (service_visit_id, captured_at, dump_receipt_id);

CREATE TABLE IF NOT EXISTS mbt_driver_bin_billing_triggers (
  billing_trigger_id uuid PRIMARY KEY,
  source_driver_event_id uuid NOT NULL UNIQUE,
  contract_id uuid NOT NULL REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  service_visit_id uuid NOT NULL REFERENCES mbt_service_visits(service_visit_id) ON DELETE RESTRICT,
  trigger_kind text NOT NULL,
  posting_mode text NOT NULL DEFAULT 'local_only',
  trigger_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_driver_bin_billing_trigger_kind
    CHECK (trigger_kind IN ('step_completed', 'visit_completed', 'dump_receipt_recorded')),
  CONSTRAINT mbt_driver_bin_billing_trigger_local_only
    CHECK (posting_mode = 'local_only'),
  CONSTRAINT mbt_driver_bin_billing_trigger_snapshot
    CHECK (jsonb_typeof(trigger_snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_mbt_driver_bin_billing_trigger_visit
  ON mbt_driver_bin_billing_triggers (service_visit_id, created_at, billing_trigger_id);
