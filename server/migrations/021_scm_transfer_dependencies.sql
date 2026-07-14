ALTER TABLE sales_order_lines
  ADD COLUMN IF NOT EXISTS netsuite_committed_qty numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS netsuite_backordered_qty numeric NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS scm_transfer_dependency_batches (
  id bigserial PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  sales_order_ref text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft',
  inventory_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  inventory_snapshot_at timestamptz,
  uncovered_shortage_qty numeric NOT NULL DEFAULT 0,
  allow_incomplete_coverage boolean NOT NULL DEFAULT false,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT scm_transfer_dependency_batches_status_check CHECK (
    status IN ('draft', 'suggested', 'creating', 'partially_created', 'created', 'attention', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_batches_so
  ON scm_transfer_dependency_batches (sales_order_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS scm_transfer_dependency_proposals (
  id bigserial PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES scm_transfer_dependency_batches(id) ON DELETE CASCADE,
  proposal_key text NOT NULL,
  dependency_mode text NOT NULL DEFAULT 'yard_replenishment',
  from_location_id bigint NOT NULL,
  from_location text NOT NULL,
  to_location_id bigint NOT NULL,
  to_location text NOT NULL,
  memo text,
  route_minutes numeric,
  priority_penalty_minutes numeric NOT NULL DEFAULT 0,
  route_score numeric,
  creation_status text NOT NULL DEFAULT 'draft',
  netsuite_transfer_order_id bigint,
  netsuite_transfer_order_ref text,
  creation_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_transfer_dependency_proposals_mode_check CHECK (
    dependency_mode IN ('yard_replenishment', 'direct_to_customer')
  ),
  CONSTRAINT scm_transfer_dependency_proposals_status_check CHECK (
    creation_status IN ('draft', 'creating', 'created', 'failed', 'cancelled')
  ),
  CONSTRAINT scm_transfer_dependency_proposals_location_check CHECK (from_location_id <> to_location_id),
  UNIQUE (batch_id, proposal_key)
);

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_proposals_batch
  ON scm_transfer_dependency_proposals (batch_id, creation_status, id);

CREATE TABLE IF NOT EXISTS scm_transfer_dependency_proposal_lines (
  id bigserial PRIMARY KEY,
  proposal_id bigint NOT NULL REFERENCES scm_transfer_dependency_proposals(id) ON DELETE CASCADE,
  sales_line_id bigint NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
  item_id bigint NOT NULL,
  item_name text,
  unit text,
  proposed_quantity numeric NOT NULL,
  pallet_qty numeric NOT NULL DEFAULT 0,
  layer_qty numeric NOT NULL DEFAULT 0,
  section_qty numeric NOT NULL DEFAULT 0,
  piece_qty numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_transfer_dependency_proposal_lines_qty_check CHECK (proposed_quantity > 0),
  UNIQUE (proposal_id, sales_line_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_transfer_dependency_proposal_lines_item
  ON scm_transfer_dependency_proposal_lines (item_id, proposal_id);

CREATE TABLE IF NOT EXISTS order_dependencies (
  id bigserial PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  sales_order_ref text NOT NULL,
  transfer_order_id bigint NOT NULL REFERENCES transfer_orders(netsuite_id) ON DELETE CASCADE,
  transfer_order_ref text NOT NULL,
  proposal_id bigint REFERENCES scm_transfer_dependency_proposals(id) ON DELETE SET NULL,
  dependency_mode text NOT NULL DEFAULT 'yard_replenishment',
  same_load_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  source_location_id bigint NOT NULL,
  source_location text NOT NULL,
  accounting_destination_location_id bigint NOT NULL,
  accounting_destination_location text,
  planned_plan_id bigint,
  planned_date date,
  planned_truck_plate text,
  planned_load_id text,
  planned_load_name text,
  local_completed_at timestamptz,
  direct_received_at timestamptz,
  direct_receipt_job_id text,
  reconciliation_status text NOT NULL DEFAULT 'pending',
  reconciled_at timestamptz,
  attention_reason text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_dependencies_mode_check CHECK (
    dependency_mode IN ('yard_replenishment', 'direct_to_customer')
  ),
  CONSTRAINT order_dependencies_status_check CHECK (
    status IN ('active', 'packed', 'loaded', 'in_transit', 'delivered', 'received_local', 'attention', 'cancelled')
  ),
  CONSTRAINT order_dependencies_reconciliation_check CHECK (
    reconciliation_status IN ('pending', 'required', 'reconciled', 'attention', 'not_required')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_dependencies_active_transfer
  ON order_dependencies (transfer_order_id)
  WHERE status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_dependencies_direct_receipt_job
  ON order_dependencies (direct_receipt_job_id)
  WHERE direct_receipt_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_dependencies_sales
  ON order_dependencies (sales_order_id, status, dependency_mode);

CREATE INDEX IF NOT EXISTS idx_order_dependencies_plan
  ON order_dependencies (planned_date, planned_truck_plate, planned_load_id);

CREATE TABLE IF NOT EXISTS order_dependency_lines (
  id bigserial PRIMARY KEY,
  dependency_id bigint NOT NULL REFERENCES order_dependencies(id) ON DELETE CASCADE,
  sales_line_id bigint NOT NULL REFERENCES sales_order_lines(id) ON DELETE RESTRICT,
  transfer_outbound_line_id bigint,
  transfer_receiving_line_id bigint,
  item_id bigint NOT NULL,
  item_name text,
  unit text,
  allocated_quantity numeric NOT NULL,
  pallet_qty numeric NOT NULL DEFAULT 0,
  layer_qty numeric NOT NULL DEFAULT 0,
  section_qty numeric NOT NULL DEFAULT 0,
  piece_qty numeric NOT NULL DEFAULT 0,
  loaded_quantity numeric NOT NULL DEFAULT 0,
  delivered_quantity numeric NOT NULL DEFAULT 0,
  locally_received_quantity numeric NOT NULL DEFAULT 0,
  locally_received_pallet_qty numeric NOT NULL DEFAULT 0,
  locally_received_layer_qty numeric NOT NULL DEFAULT 0,
  locally_received_section_qty numeric NOT NULL DEFAULT 0,
  locally_received_piece_qty numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_dependency_lines_allocated_check CHECK (allocated_quantity > 0),
  CONSTRAINT order_dependency_lines_progress_check CHECK (
    loaded_quantity >= 0 AND delivered_quantity >= 0 AND locally_received_quantity >= 0
  ),
  UNIQUE (dependency_id, sales_line_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_order_dependency_lines_item
  ON order_dependency_lines (item_id, dependency_id);

CREATE INDEX IF NOT EXISTS idx_order_dependency_lines_transfer_outbound
  ON order_dependency_lines (transfer_outbound_line_id)
  WHERE transfer_outbound_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_dependency_receipts (
  id bigserial PRIMARY KEY,
  dependency_id bigint NOT NULL REFERENCES order_dependencies(id) ON DELETE CASCADE,
  driver_job_id text NOT NULL,
  sales_order_ref text NOT NULL,
  transfer_order_ref text NOT NULL,
  plan_id bigint,
  plan_date date,
  truck_plate text,
  load_id text,
  load_name text,
  received_quantity numeric NOT NULL DEFAULT 0,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dependency_id, driver_job_id)
);

COMMENT ON TABLE order_dependencies IS
  'SCM-to-dispatch SO/TO dependency ledger. Direct-to-customer rows use local receiving only after the SO customer drop.';

COMMENT ON COLUMN order_dependencies.accounting_destination_location_id IS
  'NetSuite TO destination. It is not a physical dispatch stop for direct_to_customer dependencies.';
