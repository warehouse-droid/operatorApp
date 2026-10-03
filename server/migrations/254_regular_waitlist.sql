-- Waitlist demand is independent of Transfer/Purchase Stocking and Dispatch links.
ALTER TABLE sales_stock_request_lines DROP CONSTRAINT sales_stock_request_lines_stocking_type_check;
ALTER TABLE sales_stock_request_lines ADD CONSTRAINT sales_stock_request_lines_stocking_type_check
  CHECK (stocking_type IN ('transfer','purchase','waitlist'));
ALTER TABLE sales_stock_request_lines DROP CONSTRAINT sales_stock_request_lines_route_check;
ALTER TABLE sales_stock_request_lines ADD CONSTRAINT sales_stock_request_lines_route_check CHECK (
  destination_location_id IN (1,28,15,26) AND (
    (stocking_type IN ('purchase','waitlist') AND source_location_id IS NULL AND source_name IS NULL) OR
    (stocking_type='transfer' AND source_location_id IN (1,28,15,26) AND source_location_id IS NOT NULL
      AND source_name IS NOT NULL AND source_location_id<>destination_location_id)
  )
);
CREATE UNIQUE INDEX sales_stock_waitlist_one_item ON sales_stock_request_lines(request_id) WHERE stocking_type='waitlist';

CREATE TABLE regular_waitlist_requests (
  request_id bigint PRIMARY KEY REFERENCES sales_stock_requests(id) ON DELETE RESTRICT,
  request_line_id bigint NOT NULL UNIQUE REFERENCES sales_stock_request_lines(id) ON DELETE RESTRICT,
  customer_id bigint NOT NULL CHECK(customer_id>0),
  closed_at timestamptz,
  closed_by text REFERENCES operators(id) ON DELETE RESTRICT,
  close_reason text,
  CHECK((closed_at IS NULL AND closed_by IS NULL AND close_reason IS NULL) OR closed_at IS NOT NULL)
);
CREATE TABLE regular_waitlist_pools (
  id bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(netsuite_id) ON DELETE RESTRICT,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  sales_uom text NOT NULL CHECK(length(btrim(sales_uom))>0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_return_event_id bigint NOT NULL DEFAULT 0,
  UNIQUE(purchase_order_id,item_id)
);
CREATE TABLE regular_waitlist_conversions (
  id uuid PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES regular_waitlist_requests(request_id) ON DELETE RESTRICT,
  operation_key uuid NOT NULL UNIQUE,
  quantity numeric(20,6) NOT NULL CHECK(quantity>0 AND quantity<=1000000000),
  remainder_action text NOT NULL CHECK(remainder_action IN ('keep','close')),
  fulfillment jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','preparing','submitted','uncertain','completed','failed')),
  actor_id text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  remote_started_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  payload jsonb,
  sales_order_id bigint CHECK(sales_order_id>0),
  sales_order_ref text,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status<>'completed' OR sales_order_id IS NOT NULL)
);
CREATE UNIQUE INDEX regular_waitlist_one_conversion_in_progress ON regular_waitlist_conversions(request_id)
  WHERE status IN ('pending','preparing','submitted','uncertain');
CREATE INDEX regular_waitlist_conversion_work ON regular_waitlist_conversions(status,updated_at)
  WHERE status IN ('pending','preparing','submitted','uncertain');
CREATE TABLE regular_waitlist_allocations (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES regular_waitlist_requests(request_id) ON DELETE RESTRICT,
  pool_id bigint NOT NULL REFERENCES regular_waitlist_pools(id) ON DELETE RESTRICT,
  quantity numeric(20,6) NOT NULL CHECK(quantity>0 AND quantity<=1000000000),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','converting','committed','released')),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  allocated_by text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  batch_key uuid NOT NULL,
  override_reason text,
  conversion_id uuid REFERENCES regular_waitlist_conversions(id) ON DELETE RESTRICT,
  released_at timestamptz,
  released_by text REFERENCES operators(id) ON DELETE RESTRICT,
  release_reason text,
  release_event_id bigint REFERENCES sales_stock_request_events(id) ON DELETE RESTRICT,
  CHECK((status IN ('converting','committed') AND conversion_id IS NOT NULL) OR status IN ('reserved','released')),
  CHECK(status<>'released' OR released_at IS NOT NULL),
  UNIQUE(batch_key,request_id)
);
CREATE INDEX regular_waitlist_allocations_request ON regular_waitlist_allocations(request_id,status);
CREATE INDEX regular_waitlist_allocations_pool ON regular_waitlist_allocations(pool_id,status);
CREATE INDEX regular_waitlist_expiring ON regular_waitlist_allocations(allocated_at,id) WHERE status='reserved';
CREATE TABLE regular_waitlist_allocation_sources (
  allocation_id bigint NOT NULL REFERENCES regular_waitlist_allocations(id) ON DELETE RESTRICT,
  po_line_id bigint NOT NULL REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  root_line_id bigint NOT NULL REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
  quantity numeric(20,6) NOT NULL CHECK(quantity>0),
  PRIMARY KEY(allocation_id,po_line_id)
);
CREATE INDEX regular_waitlist_source_commitments ON regular_waitlist_allocation_sources(root_line_id,po_line_id);
CREATE TABLE regular_waitlist_commands (
  operation_key uuid PRIMARY KEY,
  scope text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE regular_waitlist_pool_reads (
  pool_id bigint NOT NULL REFERENCES regular_waitlist_pools(id) ON DELETE CASCADE,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  event_id bigint NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(pool_id,operator_id)
);
