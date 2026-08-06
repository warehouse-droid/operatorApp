-- MBT Phase 1 billing, deposit, cross-charge, Sales Order chain, durable
-- NetSuite outbox, attempt, and reconciliation foundations. No scheduler or
-- NetSuite mutation capability is introduced by this migration.

CREATE TABLE IF NOT EXISTS mbt_cross_charge_cases (
  cross_charge_case_id uuid PRIMARY KEY,
  source_type text NOT NULL,
  root_reference text NOT NULL,
  physical_load_id text NOT NULL,
  allocation_group_id uuid,
  plan_date date NOT NULL,
  truck_id bigint REFERENCES dispatch_trucks(id) ON DELETE RESTRICT,
  driver_id bigint REFERENCES dispatch_drivers(id) ON DELETE RESTRICT,
  rate_card_version_id uuid NOT NULL REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  rate_distance_band_id uuid REFERENCES mbt_rate_distance_bands(rate_distance_band_id) ON DELETE RESTRICT,
  distance_snapshot_id uuid REFERENCES mbt_distance_snapshots(distance_snapshot_id) ON DELETE RESTRICT,
  calculated_metres bigint NOT NULL,
  base_amount_minor bigint NOT NULL,
  downtown_surcharge_minor bigint NOT NULL DEFAULT 0,
  allocated_amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  status text NOT NULL DEFAULT 'pending',
  source_snapshot jsonb NOT NULL,
  calculation_snapshot jsonb NOT NULL,
  completed_load_at timestamptz NOT NULL,
  approved_at timestamptz,
  approved_by text,
  approval_reason text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_cross_charge_cases_source_type
    CHECK (source_type IN ('SO', 'TO', 'PO', 'VRMA')),
  CONSTRAINT mbt_cross_charge_cases_root_not_blank
    CHECK (NULLIF(btrim(root_reference), '') IS NOT NULL),
  CONSTRAINT mbt_cross_charge_cases_load_not_blank
    CHECK (NULLIF(btrim(physical_load_id), '') IS NOT NULL),
  CONSTRAINT mbt_cross_charge_cases_metres_nonnegative
    CHECK (calculated_metres >= 0),
  CONSTRAINT mbt_cross_charge_cases_amounts_nonnegative
    CHECK (
      base_amount_minor >= 0
      AND downtown_surcharge_minor >= 0
      AND allocated_amount_minor >= 0
    ),
  CONSTRAINT mbt_cross_charge_cases_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT mbt_cross_charge_cases_status
    CHECK (status IN ('pending', 'ready', 'in_review', 'approved', 'posted', 'attention', 'voided')),
  CONSTRAINT mbt_cross_charge_cases_snapshots_object
    CHECK (jsonb_typeof(source_snapshot) = 'object' AND jsonb_typeof(calculation_snapshot) = 'object'),
  CONSTRAINT mbt_cross_charge_cases_approval_complete
    CHECK (
      status <> 'approved'
      OR
      (
        approved_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(approved_by, '')), '') IS NOT NULL
        AND NULLIF(btrim(COALESCE(approval_reason, '')), '') IS NOT NULL
      )
    ),
  CONSTRAINT mbt_cross_charge_cases_revision_positive
    CHECK (revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_cross_charge_cases_so_load
  ON mbt_cross_charge_cases (root_reference, physical_load_id)
  WHERE source_type = 'SO';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_cross_charge_cases_po_load
  ON mbt_cross_charge_cases (root_reference, physical_load_id)
  WHERE source_type = 'PO';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_cross_charge_cases_vrma_load
  ON mbt_cross_charge_cases (root_reference, physical_load_id)
  WHERE source_type = 'VRMA';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_cross_charge_cases_to_global
  ON mbt_cross_charge_cases (root_reference)
  WHERE source_type = 'TO';

CREATE INDEX IF NOT EXISTS idx_mbt_cross_charge_cases_queue
  ON mbt_cross_charge_cases (status, plan_date, cross_charge_case_id);

CREATE TABLE IF NOT EXISTS mbt_cross_charge_allocations (
  cross_charge_allocation_id uuid PRIMARY KEY,
  cross_charge_case_id uuid NOT NULL REFERENCES mbt_cross_charge_cases(cross_charge_case_id) ON DELETE RESTRICT,
  allocation_group_id uuid NOT NULL,
  source_type text NOT NULL,
  root_reference text NOT NULL,
  sorted_ordinal integer NOT NULL,
  eligible_reference_count integer NOT NULL,
  shared_total_minor bigint NOT NULL,
  allocated_amount_minor bigint NOT NULL,
  remainder_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CAD',
  allocation_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_cross_charge_allocations_source_type
    CHECK (source_type IN ('TO', 'PO', 'VRMA')),
  CONSTRAINT mbt_cross_charge_allocations_root_not_blank
    CHECK (NULLIF(btrim(root_reference), '') IS NOT NULL),
  CONSTRAINT mbt_cross_charge_allocations_ordinal_nonnegative
    CHECK (sorted_ordinal >= 0),
  CONSTRAINT mbt_cross_charge_allocations_count_positive
    CHECK (eligible_reference_count > 0 AND sorted_ordinal < eligible_reference_count),
  CONSTRAINT mbt_cross_charge_allocations_amounts_nonnegative
    CHECK (shared_total_minor >= 0 AND allocated_amount_minor >= 0 AND remainder_minor >= 0),
  CONSTRAINT mbt_cross_charge_allocations_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT mbt_cross_charge_allocations_snapshot_object
    CHECK (jsonb_typeof(allocation_snapshot) = 'object'),
  CONSTRAINT mbt_cross_charge_allocations_case_root_unique
    UNIQUE (cross_charge_case_id, source_type, root_reference),
  CONSTRAINT mbt_cross_charge_allocations_group_ordinal_unique
    UNIQUE (allocation_group_id, sorted_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_mbt_cross_charge_allocations_group
  ON mbt_cross_charge_allocations (allocation_group_id, sorted_ordinal, root_reference);

CREATE TABLE IF NOT EXISTS mbt_billing_cases (
  billing_case_id uuid PRIMARY KEY,
  case_type text NOT NULL,
  contract_id uuid REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  service_visit_id uuid REFERENCES mbt_service_visits(service_visit_id) ON DELETE RESTRICT,
  cross_charge_case_id uuid REFERENCES mbt_cross_charge_cases(cross_charge_case_id) ON DELETE RESTRICT,
  customer_netsuite_id bigint NOT NULL REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open',
  currency text NOT NULL DEFAULT 'CAD',
  exception_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  review_note text NOT NULL DEFAULT '',
  current_version_number integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_billing_cases_type
    CHECK (case_type IN ('mbt_contract', 'mbbs_cross_charge')),
  CONSTRAINT mbt_billing_cases_origin_shape
    CHECK (
      (
        case_type = 'mbt_contract'
        AND contract_id IS NOT NULL
        AND cross_charge_case_id IS NULL
      )
      OR
      (
        case_type = 'mbbs_cross_charge'
        AND contract_id IS NULL
        AND service_visit_id IS NULL
        AND cross_charge_case_id IS NOT NULL
      )
    ),
  CONSTRAINT mbt_billing_cases_status
    CHECK (status IN ('open', 'ready', 'in_review', 'approved', 'posting', 'posted', 'attention', 'voided')),
  CONSTRAINT mbt_billing_cases_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT mbt_billing_cases_version_nonnegative
    CHECK (current_version_number >= 0),
  CONSTRAINT mbt_billing_cases_revision_positive
    CHECK (revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_billing_cases_contract_visit_open
  ON mbt_billing_cases (
    contract_id,
    COALESCE(service_visit_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE case_type = 'mbt_contract' AND status <> 'voided';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_billing_cases_cross_charge
  ON mbt_billing_cases (cross_charge_case_id)
  WHERE case_type = 'mbbs_cross_charge' AND status <> 'voided';

CREATE INDEX IF NOT EXISTS idx_mbt_billing_cases_queue
  ON mbt_billing_cases (case_type, status, updated_at, billing_case_id);

CREATE TABLE IF NOT EXISTS mbt_billing_versions (
  billing_version_id uuid PRIMARY KEY,
  billing_case_id uuid NOT NULL REFERENCES mbt_billing_cases(billing_case_id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  status text NOT NULL DEFAULT 'approved',
  rate_card_version_id uuid NOT NULL REFERENCES mbt_rate_card_versions(rate_card_version_id) ON DELETE RESTRICT,
  calculation_snapshot jsonb NOT NULL,
  source_revision_snapshot jsonb NOT NULL,
  subtotal_minor bigint NOT NULL,
  estimated_tax_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  approved_by text NOT NULL,
  approval_reason text NOT NULL,
  approved_at timestamptz NOT NULL,
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_billing_versions_number_positive
    CHECK (version_number > 0),
  CONSTRAINT mbt_billing_versions_status
    CHECK (status IN ('draft', 'approved', 'voided')),
  CONSTRAINT mbt_billing_versions_snapshots_object
    CHECK (jsonb_typeof(calculation_snapshot) = 'object' AND jsonb_typeof(source_revision_snapshot) = 'object'),
  CONSTRAINT mbt_billing_versions_amounts_nonnegative
    CHECK (subtotal_minor >= 0 AND estimated_tax_minor >= 0 AND total_minor >= 0),
  CONSTRAINT mbt_billing_versions_total_consistent
    CHECK (total_minor = subtotal_minor + estimated_tax_minor),
  CONSTRAINT mbt_billing_versions_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT mbt_billing_versions_approver_not_blank
    CHECK (NULLIF(btrim(approved_by), '') IS NOT NULL),
  CONSTRAINT mbt_billing_versions_reason_not_blank
    CHECK (NULLIF(btrim(approval_reason), '') IS NOT NULL),
  CONSTRAINT mbt_billing_versions_correlation_not_blank
    CHECK (NULLIF(btrim(correlation_id), '') IS NOT NULL),
  CONSTRAINT mbt_billing_versions_idempotency_not_blank
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL),
  CONSTRAINT mbt_billing_versions_case_version_unique
    UNIQUE (billing_case_id, version_number),
  CONSTRAINT mbt_billing_versions_case_idempotency_unique
    UNIQUE (billing_case_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mbt_billing_versions_case
  ON mbt_billing_versions (billing_case_id, version_number DESC, billing_version_id);

CREATE TABLE IF NOT EXISTS mbt_billing_lines (
  billing_line_id uuid PRIMARY KEY,
  billing_version_id uuid NOT NULL REFERENCES mbt_billing_versions(billing_version_id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL,
  line_type text NOT NULL,
  description text NOT NULL,
  quantity numeric(18, 6) NOT NULL DEFAULT 1,
  unit_of_measure text NOT NULL DEFAULT 'EA',
  unit_amount_minor bigint NOT NULL,
  net_amount_minor bigint NOT NULL,
  estimated_tax_minor bigint NOT NULL DEFAULT 0,
  total_amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  revenue_class text NOT NULL,
  rate_component_id uuid REFERENCES mbt_rate_components(rate_component_id) ON DELETE RESTRICT,
  dump_tariff_id uuid REFERENCES mbt_dump_tariffs(dump_tariff_id) ON DELETE RESTRICT,
  distance_snapshot_id uuid REFERENCES mbt_distance_snapshots(distance_snapshot_id) ON DELETE RESTRICT,
  source_entity_type text NOT NULL,
  source_entity_id uuid NOT NULL,
  netsuite_item_mapping_key text NOT NULL,
  calculation_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_references uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_billing_lines_sequence_nonnegative
    CHECK (sequence_number >= 0),
  CONSTRAINT mbt_billing_lines_type
    CHECK (
      line_type IN (
        'transport', 'rental', 'extension', 'exchange', 'pickup', 'dump',
        'downtown_surcharge', 'other'
      )
    ),
  CONSTRAINT mbt_billing_lines_description_not_blank
    CHECK (NULLIF(btrim(description), '') IS NOT NULL),
  CONSTRAINT mbt_billing_lines_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT mbt_billing_lines_uom_not_blank
    CHECK (NULLIF(btrim(unit_of_measure), '') IS NOT NULL),
  CONSTRAINT mbt_billing_lines_amounts_nonnegative
    CHECK (
      unit_amount_minor >= 0
      AND net_amount_minor >= 0
      AND estimated_tax_minor >= 0
      AND total_amount_minor >= 0
    ),
  CONSTRAINT mbt_billing_lines_total_consistent
    CHECK (total_amount_minor = net_amount_minor + estimated_tax_minor),
  CONSTRAINT mbt_billing_lines_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT mbt_billing_lines_revenue_class_not_blank
    CHECK (NULLIF(btrim(revenue_class), '') IS NOT NULL),
  CONSTRAINT mbt_billing_lines_source_type_not_blank
    CHECK (NULLIF(btrim(source_entity_type), '') IS NOT NULL),
  CONSTRAINT mbt_billing_lines_mapping_key_not_blank
    CHECK (NULLIF(btrim(netsuite_item_mapping_key), '') IS NOT NULL),
  CONSTRAINT mbt_billing_lines_detail_object
    CHECK (jsonb_typeof(calculation_detail) = 'object'),
  CONSTRAINT mbt_billing_lines_version_sequence_unique
    UNIQUE (billing_version_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS mbt_netsuite_sales_order_chain (
  sales_order_chain_id uuid PRIMARY KEY,
  order_kind text NOT NULL,
  contract_id uuid REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  cross_charge_case_id uuid REFERENCES mbt_cross_charge_cases(cross_charge_case_id) ON DELETE RESTRICT,
  customer_netsuite_id bigint NOT NULL REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  subsidiary_netsuite_id bigint NOT NULL,
  sequence_number integer NOT NULL,
  billing_version_id uuid NOT NULL REFERENCES mbt_billing_versions(billing_version_id) ON DELETE RESTRICT,
  billing_line_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  predecessor_chain_id uuid REFERENCES mbt_netsuite_sales_order_chain(sales_order_chain_id) ON DELETE RESTRICT,
  predecessor_netsuite_id bigint,
  netsuite_id bigint,
  netsuite_reference text,
  netsuite_status text NOT NULL DEFAULT 'pending',
  external_idempotency_key text NOT NULL UNIQUE,
  posted_at timestamptz,
  last_synced_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_netsuite_sales_order_chain_kind
    CHECK (order_kind IN ('mbt_customer', 'mbbs_sot')),
  CONSTRAINT mbt_netsuite_sales_order_chain_origin_shape
    CHECK (
      (order_kind = 'mbt_customer' AND contract_id IS NOT NULL AND cross_charge_case_id IS NULL)
      OR
      (order_kind = 'mbbs_sot' AND contract_id IS NULL AND cross_charge_case_id IS NOT NULL)
    ),
  CONSTRAINT mbt_netsuite_sales_order_chain_subsidiary_positive
    CHECK (subsidiary_netsuite_id > 0),
  CONSTRAINT mbt_netsuite_sales_order_chain_sequence_positive
    CHECK (sequence_number > 0),
  CONSTRAINT mbt_netsuite_sales_order_chain_predecessor_not_self
    CHECK (predecessor_chain_id IS NULL OR predecessor_chain_id <> sales_order_chain_id),
  CONSTRAINT mbt_netsuite_sales_order_chain_external_key_not_blank
    CHECK (NULLIF(btrim(external_idempotency_key), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_sales_order_chain_status
    CHECK (
      netsuite_status IN (
        'pending', 'posting', 'open', 'partially_billed', 'billed',
        'closed', 'cancelled', 'attention'
      )
    ),
  CONSTRAINT mbt_netsuite_sales_order_chain_external_identity
    CHECK (
      (netsuite_id IS NULL AND netsuite_reference IS NULL AND posted_at IS NULL)
      OR
      (
        netsuite_id IS NOT NULL
        AND netsuite_id > 0
        AND NULLIF(btrim(COALESCE(netsuite_reference, '')), '') IS NOT NULL
        AND posted_at IS NOT NULL
      )
    ),
  CONSTRAINT mbt_netsuite_sales_order_chain_revision_positive
    CHECK (revision > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_netsuite_sales_order_chain_contract_sequence
  ON mbt_netsuite_sales_order_chain (contract_id, sequence_number)
  WHERE order_kind = 'mbt_customer';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_netsuite_sales_order_chain_sot_sequence
  ON mbt_netsuite_sales_order_chain (cross_charge_case_id, sequence_number)
  WHERE order_kind = 'mbbs_sot';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_netsuite_sales_order_chain_netsuite_id
  ON mbt_netsuite_sales_order_chain (netsuite_id)
  WHERE netsuite_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mbt_deposit_records (
  deposit_record_id uuid PRIMARY KEY,
  customer_netsuite_id bigint NOT NULL REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES mbt_contracts(contract_id) ON DELETE RESTRICT,
  sales_order_chain_id uuid REFERENCES mbt_netsuite_sales_order_chain(sales_order_chain_id) ON DELETE RESTRICT,
  deposit_rule_id uuid REFERENCES mbt_deposit_rules(deposit_rule_id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'CAD',
  payment_date date NOT NULL,
  payment_method text NOT NULL,
  payment_reference text NOT NULL,
  account_mapping_key text NOT NULL,
  funds_confirmed_at timestamptz NOT NULL,
  funds_confirmed_by text NOT NULL,
  funds_confirmation_receipt_id uuid NOT NULL REFERENCES mbt_command_receipts(receipt_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  netsuite_id bigint,
  netsuite_reference text,
  posted_amount_minor bigint,
  posted_at timestamptz,
  reconciled_at timestamptz,
  reconciliation_note text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_deposit_records_amount_positive
    CHECK (amount_minor > 0),
  CONSTRAINT mbt_deposit_records_currency_iso
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT mbt_deposit_records_payment_method_not_blank
    CHECK (NULLIF(btrim(payment_method), '') IS NOT NULL),
  CONSTRAINT mbt_deposit_records_payment_reference_not_blank
    CHECK (NULLIF(btrim(payment_reference), '') IS NOT NULL),
  CONSTRAINT mbt_deposit_records_account_mapping_not_blank
    CHECK (NULLIF(btrim(account_mapping_key), '') IS NOT NULL),
  CONSTRAINT mbt_deposit_records_funds_confirmer_not_blank
    CHECK (NULLIF(btrim(funds_confirmed_by), '') IS NOT NULL),
  CONSTRAINT mbt_deposit_records_status
    CHECK (status IN ('pending', 'posting', 'posted', 'reconciled', 'failed', 'attention', 'voided')),
  CONSTRAINT mbt_deposit_records_netsuite_identity
    CHECK (
      (netsuite_id IS NULL AND netsuite_reference IS NULL AND posted_amount_minor IS NULL AND posted_at IS NULL)
      OR
      (
        netsuite_id IS NOT NULL
        AND netsuite_id > 0
        AND NULLIF(btrim(COALESCE(netsuite_reference, '')), '') IS NOT NULL
        AND posted_amount_minor IS NOT NULL
        AND posted_amount_minor > 0
        AND posted_at IS NOT NULL
      )
    ),
  CONSTRAINT mbt_deposit_records_revision_positive
    CHECK (revision > 0),
  CONSTRAINT mbt_deposit_records_funds_receipt_unique
    UNIQUE (funds_confirmation_receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_mbt_deposit_records_contract
  ON mbt_deposit_records (contract_id, status, payment_date, deposit_record_id);

CREATE TABLE IF NOT EXISTS mbt_netsuite_outbox (
  outbox_id uuid PRIMARY KEY,
  external_idempotency_key text NOT NULL,
  operation_type text NOT NULL,
  target_record_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  billing_version_id uuid REFERENCES mbt_billing_versions(billing_version_id) ON DELETE RESTRICT,
  sales_order_chain_id uuid REFERENCES mbt_netsuite_sales_order_chain(sales_order_chain_id) ON DELETE RESTRICT,
  deposit_record_id uuid REFERENCES mbt_deposit_records(deposit_record_id) ON DELETE RESTRICT,
  parent_outbox_id uuid REFERENCES mbt_netsuite_outbox(outbox_id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_owner text,
  lease_acquired_at timestamptz,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  external_acknowledged_at timestamptz,
  lookup_required boolean NOT NULL DEFAULT false,
  netsuite_id bigint,
  netsuite_reference text,
  response_snapshot jsonb,
  error_code text,
  error_message text,
  attention_reason text,
  posted_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_netsuite_outbox_external_key_not_blank
    CHECK (NULLIF(btrim(external_idempotency_key), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_outbox_operation
    CHECK (
      operation_type IN (
        'create_sales_order', 'update_sales_order', 'create_customer_deposit',
        'upload_receipt', 'attach_receipt'
      )
    ),
  CONSTRAINT mbt_netsuite_outbox_target
    CHECK (target_record_type IN ('sales_order', 'customer_deposit', 'file', 'file_attachment')),
  CONSTRAINT mbt_netsuite_outbox_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT mbt_netsuite_outbox_payload_hash_sha256
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_netsuite_outbox_parent_not_self
    CHECK (parent_outbox_id IS NULL OR parent_outbox_id <> outbox_id),
  CONSTRAINT mbt_netsuite_outbox_state
    CHECK (state IN ('pending', 'leased', 'sent', 'reconciled', 'failed', 'attention', 'voided')),
  CONSTRAINT mbt_netsuite_outbox_attempt_count_nonnegative
    CHECK (attempt_count >= 0),
  CONSTRAINT mbt_netsuite_outbox_lease_complete
    CHECK (
      (
        state = 'leased'
        AND lease_token IS NOT NULL
        AND NULLIF(btrim(COALESCE(lease_owner, '')), '') IS NOT NULL
        AND lease_acquired_at IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > lease_acquired_at
      )
      OR
      (
        state <> 'leased'
        AND lease_token IS NULL
        AND lease_owner IS NULL
        AND lease_acquired_at IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  CONSTRAINT mbt_netsuite_outbox_uncertain_lookup
    CHECK (NOT lookup_required OR (sent_at IS NOT NULL AND external_acknowledged_at IS NULL)),
  CONSTRAINT mbt_netsuite_outbox_ack_order
    CHECK (sent_at IS NULL OR external_acknowledged_at IS NULL OR external_acknowledged_at >= sent_at),
  CONSTRAINT mbt_netsuite_outbox_external_identity
    CHECK (
      (netsuite_id IS NULL AND netsuite_reference IS NULL)
      OR
      (
        netsuite_id IS NOT NULL
        AND netsuite_id > 0
        AND NULLIF(btrim(COALESCE(netsuite_reference, '')), '') IS NOT NULL
      )
    ),
  CONSTRAINT mbt_netsuite_outbox_response_object
    CHECK (response_snapshot IS NULL OR jsonb_typeof(response_snapshot) = 'object'),
  CONSTRAINT mbt_netsuite_outbox_sent_requires_ack
    CHECK (state <> 'sent' OR external_acknowledged_at IS NOT NULL),
  CONSTRAINT mbt_netsuite_outbox_sent_timestamp
    CHECK (state NOT IN ('sent', 'reconciled') OR posted_at IS NOT NULL),
  CONSTRAINT mbt_netsuite_outbox_failure_detail
    CHECK (
      state <> 'failed'
      OR NULLIF(btrim(COALESCE(error_code, '')), '') IS NOT NULL
    ),
  CONSTRAINT mbt_netsuite_outbox_attention_detail
    CHECK (
      state <> 'attention'
      OR NULLIF(btrim(COALESCE(attention_reason, '')), '') IS NOT NULL
    ),
  CONSTRAINT mbt_netsuite_outbox_reconciled_complete
    CHECK (state <> 'reconciled' OR (external_acknowledged_at IS NOT NULL AND reconciled_at IS NOT NULL)),
  CONSTRAINT mbt_netsuite_outbox_external_idempotency_unique
    UNIQUE (external_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_outbox_claim
  ON mbt_netsuite_outbox (next_attempt_at, created_at, outbox_id)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_outbox_expired_lease
  ON mbt_netsuite_outbox (lease_expires_at, outbox_id)
  WHERE state = 'leased';

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_outbox_attention
  ON mbt_netsuite_outbox (state, updated_at, outbox_id)
  WHERE state IN ('failed', 'attention');

CREATE TABLE IF NOT EXISTS mbt_netsuite_outbox_attempts (
  outbox_attempt_id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES mbt_netsuite_outbox(outbox_id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  worker_id text NOT NULL,
  lease_token uuid NOT NULL,
  attempt_stage text NOT NULL,
  outcome text NOT NULL,
  request_payload_hash text NOT NULL,
  response_snapshot jsonb,
  netsuite_id bigint,
  netsuite_reference text,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL,
  sent_at timestamptz,
  external_acknowledged_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_netsuite_outbox_attempts_number_positive
    CHECK (attempt_number > 0),
  CONSTRAINT mbt_netsuite_outbox_attempts_worker_not_blank
    CHECK (NULLIF(btrim(worker_id), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_outbox_attempts_stage
    CHECK (attempt_stage IN ('claim', 'lookup', 'send', 'readback', 'upload', 'attach')),
  CONSTRAINT mbt_netsuite_outbox_attempts_outcome
    CHECK (outcome IN ('succeeded', 'definitive_failure', 'uncertain')),
  CONSTRAINT mbt_netsuite_outbox_attempts_request_hash_sha256
    CHECK (request_payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mbt_netsuite_outbox_attempts_response_object
    CHECK (response_snapshot IS NULL OR jsonb_typeof(response_snapshot) = 'object'),
  CONSTRAINT mbt_netsuite_outbox_attempts_netsuite_identity
    CHECK (
      (netsuite_id IS NULL AND netsuite_reference IS NULL)
      OR
      (
        netsuite_id IS NOT NULL
        AND netsuite_id > 0
        AND NULLIF(btrim(COALESCE(netsuite_reference, '')), '') IS NOT NULL
      )
    ),
  CONSTRAINT mbt_netsuite_outbox_attempts_time_order
    CHECK (
      (sent_at IS NULL OR sent_at >= started_at)
      AND (external_acknowledged_at IS NULL OR (sent_at IS NOT NULL AND external_acknowledged_at >= sent_at))
      AND (completed_at IS NULL OR completed_at >= started_at)
    ),
  CONSTRAINT mbt_netsuite_outbox_attempts_outcome_complete
    CHECK (completed_at IS NOT NULL),
  CONSTRAINT mbt_netsuite_outbox_attempts_outbox_number_unique
    UNIQUE (outbox_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_outbox_attempts_timeline
  ON mbt_netsuite_outbox_attempts (outbox_id, attempt_number, outbox_attempt_id);

CREATE TABLE IF NOT EXISTS mbt_netsuite_reconciliations (
  reconciliation_id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES mbt_netsuite_outbox(outbox_id) ON DELETE RESTRICT,
  netsuite_record_type text NOT NULL,
  netsuite_id bigint,
  netsuite_reference text,
  expected_snapshot jsonb NOT NULL,
  actual_snapshot jsonb,
  difference_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  unable_to_verify_reason text,
  resolved_by text,
  resolution_note text,
  resolved_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbt_netsuite_reconciliations_record_type_not_blank
    CHECK (NULLIF(btrim(netsuite_record_type), '') IS NOT NULL),
  CONSTRAINT mbt_netsuite_reconciliations_netsuite_id_positive
    CHECK (netsuite_id IS NULL OR netsuite_id > 0),
  CONSTRAINT mbt_netsuite_reconciliations_snapshots_object
    CHECK (
      jsonb_typeof(expected_snapshot) = 'object'
      AND (actual_snapshot IS NULL OR jsonb_typeof(actual_snapshot) = 'object')
      AND jsonb_typeof(difference_snapshot) = 'object'
    ),
  CONSTRAINT mbt_netsuite_reconciliations_status
    CHECK (status IN ('pending', 'matched', 'different', 'unable_to_verify', 'resolved', 'ignored')),
  CONSTRAINT mbt_netsuite_reconciliations_unable_reason
    CHECK (
      status <> 'unable_to_verify'
      OR NULLIF(btrim(COALESCE(unable_to_verify_reason, '')), '') IS NOT NULL
    ),
  CONSTRAINT mbt_netsuite_reconciliations_resolution_complete
    CHECK (
      status NOT IN ('resolved', 'ignored')
      OR
      (
        NULLIF(btrim(COALESCE(resolved_by, '')), '') IS NOT NULL
        AND NULLIF(btrim(COALESCE(resolution_note, '')), '') IS NOT NULL
        AND resolved_at IS NOT NULL
      )
    ),
  CONSTRAINT mbt_netsuite_reconciliations_revision_positive
    CHECK (revision > 0)
);

CREATE INDEX IF NOT EXISTS idx_mbt_netsuite_reconciliations_queue
  ON mbt_netsuite_reconciliations (status, checked_at, reconciliation_id);

ALTER TABLE mbt_cross_charge_cases
  ADD CONSTRAINT mbt_cross_charge_cases_version_band_fk
  FOREIGN KEY (rate_card_version_id, rate_distance_band_id)
  REFERENCES mbt_rate_distance_bands(rate_card_version_id, rate_distance_band_id)
  ON DELETE RESTRICT;

ALTER TABLE mbt_billing_cases
  ADD CONSTRAINT mbt_billing_cases_customer_contract_fk
  FOREIGN KEY (customer_netsuite_id, contract_id)
  REFERENCES mbt_contracts(customer_netsuite_id, contract_id)
  ON DELETE RESTRICT;

ALTER TABLE mbt_billing_cases
  ADD CONSTRAINT mbt_billing_cases_contract_visit_fk
  FOREIGN KEY (contract_id, service_visit_id)
  REFERENCES mbt_service_visits(contract_id, service_visit_id)
  ON DELETE RESTRICT;

ALTER TABLE mbt_netsuite_sales_order_chain
  ADD CONSTRAINT mbt_netsuite_sales_order_chain_customer_contract_fk
  FOREIGN KEY (customer_netsuite_id, contract_id)
  REFERENCES mbt_contracts(customer_netsuite_id, contract_id)
  ON DELETE RESTRICT;

ALTER TABLE mbt_deposit_records
  ADD CONSTRAINT mbt_deposit_records_customer_contract_fk
  FOREIGN KEY (customer_netsuite_id, contract_id)
  REFERENCES mbt_contracts(customer_netsuite_id, contract_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION mbt_guard_billing_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'draft'
     AND NEW.status = 'approved'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is immutable; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_billing_versions_immutable
  ON mbt_billing_versions;
CREATE TRIGGER trg_mbt_billing_versions_immutable
  BEFORE UPDATE OR DELETE ON mbt_billing_versions
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_billing_version_mutation();

CREATE OR REPLACE FUNCTION mbt_guard_billing_line_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status
    INTO parent_status
    FROM mbt_billing_versions
   WHERE billing_version_id = NEW.billing_version_id
   FOR SHARE;
  IF FOUND AND parent_status <> 'draft' THEN
    RAISE EXCEPTION 'mbt_billing_lines cannot be inserted after billing version finalization'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_billing_lines_parent_final
  ON mbt_billing_lines;
CREATE TRIGGER trg_mbt_billing_lines_parent_final
  BEFORE INSERT ON mbt_billing_lines
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_billing_line_insert();

DROP TRIGGER IF EXISTS trg_mbt_billing_lines_immutable
  ON mbt_billing_lines;
CREATE TRIGGER trg_mbt_billing_lines_immutable
  BEFORE UPDATE OR DELETE ON mbt_billing_lines
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

DROP TRIGGER IF EXISTS trg_mbt_cross_charge_allocations_immutable
  ON mbt_cross_charge_allocations;
CREATE TRIGGER trg_mbt_cross_charge_allocations_immutable
  BEFORE UPDATE OR DELETE ON mbt_cross_charge_allocations
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

DROP TRIGGER IF EXISTS trg_mbt_netsuite_outbox_attempts_immutable
  ON mbt_netsuite_outbox_attempts;
CREATE TRIGGER trg_mbt_netsuite_outbox_attempts_immutable
  BEFORE UPDATE OR DELETE ON mbt_netsuite_outbox_attempts
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

COMMENT ON TABLE mbt_billing_versions IS
  'Immutable approval-time customer or cross-charge calculation snapshot in integer minor currency units.';

COMMENT ON TABLE mbt_deposit_records IS
  'Customer Deposit intent created only from an explicit funds-confirmed command receipt; payment credentials are never stored.';

COMMENT ON TABLE mbt_netsuite_outbox IS
  'At-least-once NetSuite delivery queue with stable external identity, short leases, uncertain-send lookup, and reconciliation.';

COMMENT ON COLUMN mbt_netsuite_outbox.state IS
  'pending/leased/sent/reconciled are the worker-safe equivalents of pending/posting/posted/reconciled; attention prevents blind replay.';
