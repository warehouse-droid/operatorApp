INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES
  ('operator_netsuite_customer_pickup_if_3445', false, 'Allow Operator Customer Pickup at yard 3445 to create a NetSuite Item Fulfillment.'),
  ('operator_netsuite_receiving_ir_3445', false, 'Allow Operator Receiving at yard 3445 to create a NetSuite Item Receipt.'),
  ('operator_netsuite_delivery_prep_if_3445', false, 'Allow Operator Delivery Prep at yard 3445 to create a NetSuite Item Fulfillment.'),
  ('operator_netsuite_customer_pickup_if_2967', false, 'Allow Operator Customer Pickup at yard 2967 to create a NetSuite Item Fulfillment.'),
  ('operator_netsuite_receiving_ir_2967', false, 'Allow Operator Receiving at yard 2967 to create a NetSuite Item Receipt.'),
  ('operator_netsuite_delivery_prep_if_2967', false, 'Allow Operator Delivery Prep at yard 2967 to create a NetSuite Item Fulfillment.'),
  ('operator_netsuite_customer_pickup_if_12441', false, 'Allow Operator Customer Pickup at yard 12441 to create a NetSuite Item Fulfillment.'),
  ('operator_netsuite_receiving_ir_12441', false, 'Allow Operator Receiving at yard 12441 to create a NetSuite Item Receipt.'),
  ('operator_netsuite_delivery_prep_if_12441', false, 'Allow Operator Delivery Prep at yard 12441 to create a NetSuite Item Fulfillment.'),
  ('operator_netsuite_customer_pickup_if_150', false, 'Allow Operator Customer Pickup at yard 150 to create a NetSuite Item Fulfillment.'),
  ('operator_netsuite_receiving_ir_150', false, 'Allow Operator Receiving at yard 150 to create a NetSuite Item Receipt.'),
  ('operator_netsuite_delivery_prep_if_150', false, 'Allow Operator Delivery Prep at yard 150 to create a NetSuite Item Fulfillment.')
ON CONFLICT (flag_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS operator_netsuite_posting_commands (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  actor_operator_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  function_key text NOT NULL
    CHECK (function_key IN ('customer_pickup', 'receiving', 'delivery_prep')),
  transaction_type text NOT NULL CHECK (transaction_type IN ('IF', 'IR')),
  canonical_location_id bigint NOT NULL CHECK (canonical_location_id > 0),
  yard_code text NOT NULL CHECK (NULLIF(btrim(yard_code), '') IS NOT NULL),
  gate_key text NOT NULL REFERENCES mbt_feature_flags(flag_key) ON DELETE RESTRICT,
  gate_revision bigint NOT NULL CHECK (gate_revision > 0),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  photo_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'posting', 'attention', 'finalizing', 'completed', 'failed')),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT operator_netsuite_posting_commands_lease_state CHECK (
    (
      status IN ('posting', 'finalizing')
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      status NOT IN ('posting', 'finalizing')
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT operator_netsuite_posting_commands_completion_state CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS operator_netsuite_posting_commands_status_idx
  ON operator_netsuite_posting_commands (status, created_at, id);

CREATE INDEX IF NOT EXISTS operator_netsuite_posting_commands_expired_lease_idx
  ON operator_netsuite_posting_commands (lease_expires_at, id)
  WHERE status IN ('posting', 'finalizing');

CREATE TABLE IF NOT EXISTS operator_netsuite_posting_steps (
  id bigserial PRIMARY KEY,
  command_id uuid NOT NULL
    REFERENCES operator_netsuite_posting_commands(id) ON DELETE CASCADE,
  step_index integer NOT NULL CHECK (step_index > 0),
  source_order_kind text NOT NULL CHECK (source_order_kind IN ('SO', 'PO', 'TO')),
  source_netsuite_id bigint NOT NULL CHECK (source_netsuite_id > 0),
  source_order_ref text NOT NULL DEFAULT '',
  transaction_type text NOT NULL CHECK (transaction_type IN ('IF', 'IR')),
  external_id text NOT NULL UNIQUE
    CHECK (external_id ~ '^[A-Za-z0-9_-]+$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  line_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  baseline_transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'posting', 'uncertain', 'posted', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  netsuite_transaction_id bigint CHECK (netsuite_transaction_id IS NULL OR netsuite_transaction_id > 0),
  netsuite_transaction_ref text,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  UNIQUE (command_id, step_index),
  UNIQUE (command_id, source_order_kind, source_netsuite_id),
  CONSTRAINT operator_netsuite_posting_steps_posted_state CHECK (
    (
      status = 'posted'
      AND netsuite_transaction_id IS NOT NULL
      AND posted_at IS NOT NULL
    )
    OR status <> 'posted'
  )
);

CREATE INDEX IF NOT EXISTS operator_netsuite_posting_steps_command_idx
  ON operator_netsuite_posting_steps (command_id, step_index);

CREATE INDEX IF NOT EXISTS operator_netsuite_posting_steps_attention_idx
  ON operator_netsuite_posting_steps (status, updated_at, id)
  WHERE status IN ('uncertain', 'failed');

CREATE TABLE IF NOT EXISTS operator_netsuite_posting_order_claims (
  command_id uuid NOT NULL
    REFERENCES operator_netsuite_posting_commands(id) ON DELETE CASCADE,
  function_key text NOT NULL
    CHECK (function_key IN ('customer_pickup', 'receiving', 'delivery_prep')),
  local_order_key text NOT NULL CHECK (NULLIF(btrim(local_order_key), '') IS NOT NULL),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (command_id, function_key, local_order_key),
  CHECK (
    (active = true AND released_at IS NULL)
    OR (active = false AND released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_netsuite_posting_order_claims_active_idx
  ON operator_netsuite_posting_order_claims (function_key, local_order_key)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS operator_netsuite_posting_attempts (
  id bigserial PRIMARY KEY,
  step_id bigint NOT NULL
    REFERENCES operator_netsuite_posting_steps(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  outcome text NOT NULL
    CHECK (outcome IN ('posting', 'posted', 'recovered', 'uncertain', 'failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (step_id, attempt_number),
  CHECK (
    (outcome = 'posting' AND finished_at IS NULL)
    OR (outcome <> 'posting' AND finished_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS operator_netsuite_posting_attempts_step_idx
  ON operator_netsuite_posting_attempts (step_id, attempt_number);

COMMENT ON TABLE operator_netsuite_posting_commands IS
  'Durable Operator authorization and local-finalization state for gated NetSuite IF/IR posting.';

COMMENT ON TABLE operator_netsuite_posting_steps IS
  'Exactly-once NetSuite transform steps, one per distinct real source order in an Operator command.';

COMMENT ON TABLE operator_netsuite_posting_order_claims IS
  'Durable active-order exclusion preventing concurrent Operator posting commands for the same local draft.';

COMMENT ON TABLE operator_netsuite_posting_attempts IS
  'Immutable attempt evidence for NetSuite transform and external-ID recovery.';
