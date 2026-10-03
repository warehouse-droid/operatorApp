ALTER TABLE sales_stock_request_lines ADD COLUMN stocking_type text NOT NULL DEFAULT 'transfer'
  CHECK (stocking_type IN ('transfer','purchase'));
ALTER TABLE sales_stock_request_lines ALTER COLUMN source_location_id DROP NOT NULL;
ALTER TABLE sales_stock_request_lines ALTER COLUMN source_name DROP NOT NULL;
ALTER TABLE sales_stock_request_lines DROP CONSTRAINT sales_stock_request_lines_route_check;
ALTER TABLE sales_stock_request_lines ADD CONSTRAINT sales_stock_request_lines_route_check CHECK (
  destination_location_id IN (1,28,15,26) AND (
    (stocking_type='purchase' AND source_location_id IS NULL AND source_name IS NULL) OR
    (stocking_type='transfer' AND source_location_id IS NOT NULL AND source_name IS NOT NULL
      AND source_location_id IN (1,28,15,26) AND source_location_id<>destination_location_id)
  )
);

CREATE TABLE regular_stock_purchase_demands (
  id bigserial PRIMARY KEY,
  request_line_id bigint NOT NULL UNIQUE REFERENCES sales_stock_request_lines(id) ON DELETE RESTRICT,
  vendor_yard_id bigint NOT NULL,
  vendor_id bigint NOT NULL,
  policy_snapshot jsonb NOT NULL,
  requested_quantity numeric NOT NULL CHECK(requested_quantity>0),
  reviewed_quantity numeric NOT NULL CHECK(reviewed_quantity>0),
  approved_quantity numeric NOT NULL CHECK(approved_quantity>0 AND approved_quantity<=1000000000),
  to_plt numeric NOT NULL CHECK(to_plt>0),
  released_quantity numeric NOT NULL DEFAULT 0 CHECK(released_quantity>=0 AND released_quantity<=approved_quantity),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  accepted_by text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  release_reason text,
  released_by text REFERENCES operators(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE regular_stock_purchase_allocations (
  id bigserial PRIMARY KEY,
  demand_id bigint NOT NULL REFERENCES regular_stock_purchase_demands(id) ON DELETE RESTRICT,
  proposal_id bigint REFERENCES scm_smart_proposals(id) ON DELETE SET NULL,
  proposal_line_id bigint REFERENCES scm_smart_proposal_lines(id) ON DELETE SET NULL,
  purchase_order_id bigint,
  po_line_id bigint,
  quantity numeric NOT NULL CHECK(quantity>0),
  received_quantity numeric NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=quantity),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE INDEX regular_stock_purchase_allocations_demand ON regular_stock_purchase_allocations(demand_id,active);
CREATE INDEX regular_stock_purchase_allocations_proposal ON regular_stock_purchase_allocations(proposal_id) WHERE active;
CREATE INDEX regular_stock_purchase_allocations_po ON regular_stock_purchase_allocations(purchase_order_id,po_line_id) WHERE active;
CREATE UNIQUE INDEX regular_stock_purchase_allocation_current
  ON regular_stock_purchase_allocations(demand_id,proposal_line_id,COALESCE(purchase_order_id,0),COALESCE(po_line_id,0)) WHERE active;
CREATE TABLE regular_stock_purchase_runs (
  proposal_id bigint NOT NULL REFERENCES scm_smart_proposals(id) ON DELETE CASCADE,
  run_id bigint NOT NULL REFERENCES scm_smart_planning_runs(id) ON DELETE CASCADE,
  PRIMARY KEY(proposal_id,run_id)
);
