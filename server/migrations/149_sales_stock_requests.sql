CREATE SEQUENCE IF NOT EXISTS sales_stock_request_ref_seq;
CREATE SEQUENCE IF NOT EXISTS sales_stock_transfer_ref_seq;

CREATE TABLE IF NOT EXISTS sales_stock_requests (
  id bigserial PRIMARY KEY,
  request_ref text NOT NULL UNIQUE DEFAULT (
    'STREQ-' || LPAD(nextval('sales_stock_request_ref_seq')::text, 6, '0')
  ),
  request_type text NOT NULL DEFAULT 'regular',
  destination_location_id bigint NOT NULL,
  destination_name text NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  revision integer NOT NULL DEFAULT 1,
  first_scm_decision_at timestamptz,
  requested_by text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  cancelled_by text REFERENCES operators(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_stock_requests_type_check CHECK (request_type IN ('regular', 'special')),
  CONSTRAINT sales_stock_requests_status_check CHECK (status IN ('submitted', 'active', 'completed', 'cancelled')),
  CONSTRAINT sales_stock_requests_revision_check CHECK (revision > 0),
  CONSTRAINT sales_stock_requests_destination_check CHECK (destination_location_id IN (1, 28, 15, 26))
);

CREATE INDEX IF NOT EXISTS idx_sales_stock_requests_sales_queue
  ON sales_stock_requests (destination_location_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sales_stock_requests_scm_queue
  ON sales_stock_requests (request_type, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sales_stock_request_lines (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  item_name text NOT NULL,
  item_description text,
  source_location_id bigint NOT NULL,
  source_name text NOT NULL,
  destination_location_id bigint NOT NULL,
  destination_name text NOT NULL,
  sales_qty numeric NOT NULL,
  sales_uom text NOT NULL,
  quantity_mode text NOT NULL,
  pallet_qty numeric,
  layer_qty numeric,
  section_qty numeric,
  piece_qty numeric,
  to_plt numeric,
  to_lyr numeric,
  to_sec numeric,
  to_pcs numeric,
  status text NOT NULL DEFAULT 'submitted',
  decision_reason text,
  decided_by text REFERENCES operators(id) ON DELETE SET NULL,
  decided_at timestamptz,
  resubmitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_stock_request_lines_status_check CHECK (
    status IN ('submitted', 'changes_requested', 'converted', 'rejected', 'received', 'cancelled')
  ),
  CONSTRAINT sales_stock_request_lines_mode_check CHECK (quantity_mode IN ('conversion', 'sales')),
  CONSTRAINT sales_stock_request_lines_quantity_check CHECK (
    sales_qty > 0 AND sales_qty <= 1000000000
    AND COALESCE(pallet_qty, 0) >= 0
    AND COALESCE(layer_qty, 0) >= 0
    AND COALESCE(section_qty, 0) >= 0
    AND COALESCE(piece_qty, 0) >= 0
  ),
  CONSTRAINT sales_stock_request_lines_route_check CHECK (
    source_location_id IN (1, 28, 15, 26)
    AND destination_location_id IN (1, 28, 15, 26)
    AND source_location_id <> destination_location_id
  )
);

CREATE INDEX IF NOT EXISTS idx_sales_stock_request_lines_request
  ON sales_stock_request_lines (request_id, id);

CREATE INDEX IF NOT EXISTS idx_sales_stock_request_lines_inventory
  ON sales_stock_request_lines (item_id, source_location_id, status);

CREATE TABLE IF NOT EXISTS sales_stock_transfers (
  id bigserial PRIMARY KEY,
  transfer_ref text NOT NULL UNIQUE DEFAULT (
    'STTO-' || LPAD(nextval('sales_stock_transfer_ref_seq')::text, 6, '0')
  ),
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE RESTRICT,
  source_location_id bigint NOT NULL,
  source_name text NOT NULL,
  destination_location_id bigint NOT NULL,
  destination_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending_local',
  revision integer NOT NULL DEFAULT 1,
  pallet_item_id bigint REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  pallet_item_name text,
  pallet_quantity numeric NOT NULL DEFAULT 0,
  pallet_quantity_requires_manual boolean NOT NULL DEFAULT false,
  pallet_quantity_manually_adjusted boolean NOT NULL DEFAULT false,
  netsuite_transfer_order_id bigint,
  netsuite_transfer_order_ref text,
  netsuite_status text,
  netsuite_status_text text,
  netsuite_updated_at timestamptz,
  confirmation_status text NOT NULL DEFAULT 'idle',
  confirmation_request_id text,
  confirmation_started_at timestamptz,
  confirmation_error text,
  revision_request_id text,
  revision_error text,
  print_generation integer NOT NULL DEFAULT 0,
  print_job_id bigint REFERENCES scm_print_jobs(id) ON DELETE SET NULL,
  print_invalidated_at timestamptz,
  confirmed_by text REFERENCES operators(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_by text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_stock_transfers_route_check CHECK (
    source_location_id IN (1, 28, 15, 26)
    AND destination_location_id IN (1, 28, 15, 26)
    AND source_location_id <> destination_location_id
  ),
  CONSTRAINT sales_stock_transfers_status_check CHECK (
    status IN (
      'pending_local', 'creating', 'pending_approval', 'pending_fulfillment',
      'partially_fulfilled', 'pending_receipt', 'received', 'cancelled', 'attention'
    )
  ),
  CONSTRAINT sales_stock_transfers_confirmation_status_check CHECK (
    confirmation_status IN ('idle', 'creating', 'approving', 'hydrating', 'printing', 'complete', 'attention')
  ),
  CONSTRAINT sales_stock_transfers_revision_check CHECK (revision > 0),
  CONSTRAINT sales_stock_transfers_pallet_check CHECK (pallet_quantity >= 0),
  CONSTRAINT sales_stock_transfers_print_generation_check CHECK (print_generation >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_stock_transfers_netsuite_id
  ON sales_stock_transfers (netsuite_transfer_order_id)
  WHERE netsuite_transfer_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_stock_transfers_confirmation_request
  ON sales_stock_transfers (confirmation_request_id)
  WHERE confirmation_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_stock_transfers_queue
  ON sales_stock_transfers (status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sales_stock_transfers_request
  ON sales_stock_transfers (request_id, id);

CREATE TABLE IF NOT EXISTS sales_stock_transfer_lines (
  id bigserial PRIMARY KEY,
  transfer_id bigint NOT NULL REFERENCES sales_stock_transfers(id) ON DELETE CASCADE,
  request_line_id bigint NOT NULL UNIQUE REFERENCES sales_stock_request_lines(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  item_name text NOT NULL,
  sales_qty numeric NOT NULL,
  sales_uom text NOT NULL,
  quantity_mode text NOT NULL,
  pallet_qty numeric,
  layer_qty numeric,
  section_qty numeric,
  piece_qty numeric,
  to_plt numeric,
  to_lyr numeric,
  to_sec numeric,
  to_pcs numeric,
  netsuite_line_id bigint,
  fulfilled_qty numeric NOT NULL DEFAULT 0,
  received_qty numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_stock_transfer_lines_mode_check CHECK (quantity_mode IN ('conversion', 'sales')),
  CONSTRAINT sales_stock_transfer_lines_quantity_check CHECK (
    sales_qty > 0 AND sales_qty <= 1000000000
    AND fulfilled_qty >= 0 AND received_qty >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_sales_stock_transfer_lines_transfer
  ON sales_stock_transfer_lines (transfer_id, id);

CREATE TABLE IF NOT EXISTS sales_stock_transfer_reservations (
  id bigserial PRIMARY KEY,
  transfer_line_id bigint NOT NULL UNIQUE REFERENCES sales_stock_transfer_lines(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  source_location_id bigint NOT NULL,
  reserved_sales_quantity numeric NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_stock_transfer_reservations_status_check CHECK (status IN ('active', 'executed', 'released')),
  CONSTRAINT sales_stock_transfer_reservations_quantity_check CHECK (reserved_sales_quantity > 0),
  CONSTRAINT sales_stock_transfer_reservations_location_check CHECK (source_location_id IN (1, 28, 15, 26))
);

CREATE INDEX IF NOT EXISTS idx_sales_stock_transfer_reservations_inventory
  ON sales_stock_transfer_reservations (item_id, source_location_id, status);

CREATE TABLE IF NOT EXISTS sales_stock_request_events (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES sales_stock_requests(id) ON DELETE CASCADE,
  request_line_id bigint REFERENCES sales_stock_request_lines(id) ON DELETE SET NULL,
  transfer_id bigint REFERENCES sales_stock_transfers(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_id text REFERENCES operators(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_stock_request_events_request
  ON sales_stock_request_events (request_id, created_at DESC, id DESC);

COMMENT ON TABLE sales_stock_requests IS
  'Yard-scoped Sales regular-stock requests. Submitted requests intentionally do not reserve inventory.';

COMMENT ON TABLE sales_stock_transfer_reservations IS
  'Active reservations created only by SCM conversion and deducted from shared requestable availability.';

COMMENT ON COLUMN sales_stock_transfers.confirmation_request_id IS
  'Stable idempotency key for recoverable NetSuite TO creation, approval, hydration, and print.';

COMMENT ON COLUMN sales_stock_transfers.print_generation IS
  'Monotonic picking-ticket snapshot. Quantity edits invalidate the prior ticket and explicit re-print increments it.';
