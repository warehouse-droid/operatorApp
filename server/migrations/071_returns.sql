-- Operator PWA returns.  Local return records are authoritative for the
-- physical hand-off; NetSuite transaction links are reconciliation metadata.

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS return_policy_override text,
  ADD COLUMN IF NOT EXISTS return_policy_updated_by text,
  ADD COLUMN IF NOT EXISTS return_policy_updated_at timestamptz;

ALTER TABLE inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_return_policy_override_check,
  ADD CONSTRAINT inventory_items_return_policy_override_check
    CHECK (
      return_policy_override IS NULL
      OR return_policy_override IN ('ALLOWED', 'APPROVAL_REQUIRED', 'NOT_RETURNABLE')
    );

COMMENT ON COLUMN inventory_items.return_policy_override IS
  'Optional company-wide return-policy override. NULL derives the policy from product_type.';

CREATE TABLE IF NOT EXISTS return_yard_settings (
  location_id bigint PRIMARY KEY,
  yard_code text NOT NULL UNIQUE,
  allow_cross_yard_returns boolean NOT NULL DEFAULT false,
  auto_create_stock_ra boolean NOT NULL DEFAULT false,
  auto_create_pallet_credit_memo boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_yard_settings_location_check CHECK (location_id IN (1, 28, 15, 26))
);

INSERT INTO return_yard_settings (location_id, yard_code)
VALUES
  (1, '3445'),
  (28, '2967'),
  (15, '12441'),
  (26, '150')
ON CONFLICT (location_id) DO UPDATE
SET yard_code = EXCLUDED.yard_code;

CREATE SEQUENCE IF NOT EXISTS return_batch_reference_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS stock_return_reference_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS pallet_return_reference_seq START WITH 1;

CREATE TABLE IF NOT EXISTS return_drafts (
  id uuid PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  receiving_location_id bigint NOT NULL REFERENCES return_yard_settings(location_id),
  draft_type text NOT NULL DEFAULT 'stock' CHECK (draft_type IN ('stock', 'pallet', 'combined')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idx_return_drafts_operator
  ON return_drafts (operator_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS return_batches (
  id bigserial PRIMARY KEY,
  batch_reference text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  operator_id text NOT NULL REFERENCES operators(id),
  receiving_location_id bigint NOT NULL REFERENCES return_yard_settings(location_id),
  receiving_yard_code text NOT NULL,
  vehicle_plate text NOT NULL,
  note text,
  lookup_method text NOT NULL DEFAULT 'sales_order'
    CHECK (lookup_method IN ('sales_order', 'customer')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_return_batches_operator
  ON return_batches (operator_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS return_records (
  id bigserial PRIMARY KEY,
  record_reference text NOT NULL UNIQUE,
  batch_id bigint NOT NULL REFERENCES return_batches(id),
  record_type text NOT NULL CHECK (record_type IN ('stock', 'pallet')),
  stock_return_type text CHECK (stock_return_type IN ('normal', 'quality')),
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN (
      'accepted', 'pending_approval', 'partially_pending',
      'partially_rejected', 'rejected', 'voided'
    )),
  operator_id text NOT NULL REFERENCES operators(id),
  source_sales_order_id bigint,
  source_sales_order_ref text,
  source_order_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_id bigint NOT NULL,
  customer_code text,
  customer_name text NOT NULL,
  customer_phone text,
  customer_address text,
  customer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ordering_location_id bigint,
  ordering_location_name text,
  receiving_location_id bigint NOT NULL REFERENCES return_yard_settings(location_id),
  receiving_location_name text,
  cross_yard boolean NOT NULL DEFAULT false,
  vehicle_plate text NOT NULL,
  note text,
  pallet_quantity numeric,
  balance_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_credit numeric,
  actual_credit numeric,
  currency text,
  external_id text NOT NULL UNIQUE,
  netsuite_stage text NOT NULL DEFAULT 'local'
    CHECK (netsuite_stage IN ('local', 'return_authorization', 'credit_memo')),
  netsuite_transaction_id bigint,
  netsuite_transaction_ref text,
  netsuite_transaction_status text,
  netsuite_sync_status text NOT NULL DEFAULT 'disabled'
    CHECK (netsuite_sync_status IN (
      'disabled', 'waiting_approval', 'pending', 'succeeded',
      'failed', 'manual_linked', 'cancelled'
    )),
  netsuite_sync_attempts integer NOT NULL DEFAULT 0,
  netsuite_sync_error text,
  netsuite_last_synced_at timestamptz,
  netsuite_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by text REFERENCES operators(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_records_type_fields_check CHECK (
    (record_type = 'stock' AND stock_return_type IS NOT NULL AND source_sales_order_id IS NOT NULL)
    OR
    (record_type = 'pallet' AND stock_return_type IS NULL AND pallet_quantity > 0)
  ),
  CONSTRAINT return_records_pallet_quantity_check CHECK (
    pallet_quantity IS NULL OR (pallet_quantity > 0 AND pallet_quantity = trunc(pallet_quantity))
  ),
  CONSTRAINT return_records_void_check CHECK (
    status <> 'voided'
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_return_records_operator
  ON return_records (operator_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_return_records_control
  ON return_records (receiving_location_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_return_records_sales
  ON return_records (ordering_location_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_return_records_customer
  ON return_records (customer_id, record_type, status);
CREATE INDEX IF NOT EXISTS idx_return_records_source_order
  ON return_records (source_sales_order_id, status);
CREATE INDEX IF NOT EXISTS idx_return_records_sync
  ON return_records (netsuite_sync_status, submitted_at)
  WHERE netsuite_sync_status IN ('pending', 'failed', 'waiting_approval');
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_records_netsuite_transaction_unique
  ON return_records (netsuite_transaction_id)
  WHERE netsuite_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS return_record_lines (
  id bigserial PRIMARY KEY,
  return_record_id bigint NOT NULL REFERENCES return_records(id) ON DELETE CASCADE,
  source_sales_order_line_id bigint NOT NULL,
  netsuite_order_line_id bigint NOT NULL,
  source_local_line_id bigint,
  item_id bigint NOT NULL,
  item_name text NOT NULL,
  item_description text,
  item_type text,
  sales_uom text NOT NULL,
  sales_order_quantity numeric NOT NULL DEFAULT 0,
  fulfilled_quantity numeric NOT NULL,
  netsuite_returned_quantity numeric NOT NULL DEFAULT 0,
  local_reserved_quantity numeric NOT NULL DEFAULT 0,
  returned_sales_quantity numeric NOT NULL,
  returned_pallets integer NOT NULL DEFAULT 0,
  returned_layers integer NOT NULL DEFAULT 0,
  returned_sections integer NOT NULL DEFAULT 0,
  returned_pieces integer NOT NULL DEFAULT 0,
  to_plt numeric,
  to_lyr numeric,
  to_sec numeric,
  to_pcs numeric,
  entry_mode text NOT NULL CHECK (entry_mode IN ('physical_units', 'sales_uom')),
  return_policy_default text NOT NULL
    CHECK (return_policy_default IN ('ALLOWED', 'APPROVAL_REQUIRED', 'NOT_RETURNABLE')),
  return_policy_override text
    CHECK (return_policy_override IS NULL OR return_policy_override IN ('ALLOWED', 'APPROVAL_REQUIRED', 'NOT_RETURNABLE')),
  return_policy_effective text NOT NULL
    CHECK (return_policy_effective IN ('ALLOWED', 'APPROVAL_REQUIRED', 'NOT_RETURNABLE')),
  approval_status text NOT NULL
    CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  approval_note text,
  decided_by text REFERENCES operators(id),
  decided_at timestamptz,
  reason_id bigint NOT NULL,
  reason_code text NOT NULL,
  reason_label text NOT NULL,
  note text,
  rate numeric,
  estimated_credit numeric,
  source_line_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  netsuite_line_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_record_lines_quantity_check CHECK (
    fulfilled_quantity >= 0
    AND netsuite_order_line_id > 0
    AND netsuite_returned_quantity >= 0
    AND local_reserved_quantity >= 0
    AND returned_sales_quantity > 0
    AND returned_pallets >= 0
    AND returned_layers >= 0
    AND returned_sections >= 0
    AND returned_pieces >= 0
  ),
  CONSTRAINT return_record_lines_decision_check CHECK (
    (approval_status IN ('not_required', 'pending') AND decided_at IS NULL AND decided_by IS NULL)
    OR
    (approval_status = 'approved' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
    OR
    (approval_status = 'rejected' AND decided_at IS NOT NULL AND decided_by IS NOT NULL
      AND NULLIF(BTRIM(approval_note), '') IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_return_record_lines_record
  ON return_record_lines (return_record_id, id);
CREATE INDEX IF NOT EXISTS idx_return_record_lines_reservation
  ON return_record_lines (source_sales_order_line_id, approval_status);

CREATE TABLE IF NOT EXISTS return_photos (
  id bigserial PRIMARY KEY,
  return_record_id bigint NOT NULL REFERENCES return_records(id) ON DELETE CASCADE,
  return_line_id bigint REFERENCES return_record_lines(id) ON DELETE CASCADE,
  photo_kind text NOT NULL CHECK (photo_kind IN ('stock', 'quality_line', 'pallet')),
  photo_reference text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 5),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (return_record_id, return_line_id, photo_kind, position)
);

CREATE INDEX IF NOT EXISTS idx_return_photos_record
  ON return_photos (return_record_id, return_line_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_photos_header_position
  ON return_photos (return_record_id, photo_kind, position)
  WHERE return_line_id IS NULL;

CREATE TABLE IF NOT EXISTS return_sync_events (
  id bigserial PRIMARY KEY,
  return_record_id bigint NOT NULL REFERENCES return_records(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  status text NOT NULL,
  request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  actor_operator_id text REFERENCES operators(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_return_sync_events_record
  ON return_sync_events (return_record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS return_reason_cache (
  reason_id bigint PRIMARY KEY,
  reason_code text NOT NULL,
  reason_label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'confirmed_fallback',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO return_reason_cache (reason_id, reason_code, reason_label, source)
VALUES
  (5, 'R1', 'R1 - Color Variation', 'confirmed_fallback'),
  (6, 'R2', 'R2 - Efflorescence', 'confirmed_fallback'),
  (7, 'R3', 'R3 - Chipping / Crack', 'confirmed_fallback'),
  (8, 'R4', 'R4 - Surface', 'confirmed_fallback'),
  (9, 'R5', 'R5 - Others', 'confirmed_fallback'),
  (10, 'GD', 'GD - Good Condition', 'confirmed_fallback')
ON CONFLICT (reason_id) DO NOTHING;

COMMENT ON TABLE return_records IS
  'Immutable submitted stock and PALLET return headers. Drafts are held separately and reserve no quantity.';
COMMENT ON COLUMN return_records.netsuite_stage IS
  'Exactly one reconciliation stage is authoritative: local, Return Authorization, or Credit Memo.';
COMMENT ON TABLE return_record_lines IS
  'Sales-UOM return quantities and immutable NetSuite/order/policy snapshots used for approvals and reconciliation.';
