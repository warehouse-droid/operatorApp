-- Multi-line, one-vendor Special Item requests. The feature is fail-closed
-- until an administrator explicitly enables the rollout gate.

CREATE SEQUENCE IF NOT EXISTS sales_special_stock_request_ref_seq;

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'special_stock_request_workflow',
  false,
  'Enable the Sales, SCM, and Dispatch Special Item stock-request workflow and its guarded NetSuite SO/PO actions'
)
ON CONFLICT (flag_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS sales_special_stock_cases (
  request_id bigint PRIMARY KEY REFERENCES sales_stock_requests(id) ON DELETE CASCADE,
  inquiry_date date NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL DEFAULT '',
  canonical_customer_id bigint REFERENCES netsuite_customers(netsuite_id) ON DELETE RESTRICT,
  vendor_id bigint,
  vendor_name text NOT NULL,
  required_date date,
  estimate_netsuite_id bigint,
  estimate_ref text,
  fulfillment_method text,
  operational_yard_location_id bigint,
  delivery_address text,
  delivery_date date,
  delivery_window_start time,
  delivery_window_end time,
  delivery_instructions text,
  sales_order_source text,
  sales_order_netsuite_id bigint,
  sales_order_ref text,
  sales_order_status text,
  sales_order_approved boolean NOT NULL DEFAULT false,
  sales_order_operation_status text NOT NULL DEFAULT 'idle',
  sales_order_operation_id uuid,
  sales_order_operation_error text,
  purchase_order_netsuite_id bigint,
  purchase_order_ref text,
  purchase_order_status text,
  purchase_order_operation_status text NOT NULL DEFAULT 'idle',
  purchase_order_operation_id uuid,
  purchase_order_operation_error text,
  close_status text NOT NULL DEFAULT 'active',
  closure_reason text,
  closure_requested_by text REFERENCES operators(id) ON DELETE SET NULL,
  closure_requested_at timestamptz,
  closed_at timestamptz,
  handoff_route text,
  operationally_complete boolean NOT NULL DEFAULT false,
  operationally_completed_at timestamptz,
  operational_completion_source text,
  operationally_completed_by text REFERENCES operators(id) ON DELETE SET NULL,
  vendor_pickup_date date,
  vendor_pickup_reference text,
  remotely_reconciled boolean NOT NULL DEFAULT false,
  remotely_reconciled_at timestamptz,
  attention boolean NOT NULL DEFAULT false,
  attention_reason text,
  post_po_change_pending boolean NOT NULL DEFAULT false,
  post_po_change_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  post_po_change_acknowledged_by text REFERENCES operators(id) ON DELETE SET NULL,
  post_po_change_acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_special_stock_customer_name_check CHECK (NULLIF(btrim(customer_name), '') IS NOT NULL),
  CONSTRAINT sales_special_stock_vendor_name_check CHECK (NULLIF(btrim(vendor_name), '') IS NOT NULL),
  CONSTRAINT sales_special_stock_fulfillment_check CHECK (
    fulfillment_method IS NULL
    OR fulfillment_method IN ('vendor_pickup', 'yard_pickup', 'mbt_delivery')
  ),
  CONSTRAINT sales_special_stock_yard_check CHECK (
    operational_yard_location_id IS NULL
    OR operational_yard_location_id IN (1, 28, 15, 26)
  ),
  CONSTRAINT sales_special_stock_delivery_check CHECK (
    fulfillment_method IS DISTINCT FROM 'mbt_delivery'
    OR (
      NULLIF(btrim(delivery_address), '') IS NOT NULL
      AND delivery_date IS NOT NULL
      AND delivery_window_start IS NOT NULL
      AND delivery_window_end IS NOT NULL
      AND delivery_window_end > delivery_window_start
      AND NULLIF(btrim(delivery_instructions), '') IS NOT NULL
    )
  ),
  CONSTRAINT sales_special_stock_so_source_check CHECK (
    sales_order_source IS NULL
    OR sales_order_source IN ('estimate_transform', 'standalone', 'manual_link')
  ),
  CONSTRAINT sales_special_stock_operation_check CHECK (
    sales_order_operation_status IN ('idle', 'creating', 'linked', 'attention')
    AND purchase_order_operation_status IN ('idle', 'creating', 'linked', 'attention')
  ),
  CONSTRAINT sales_special_stock_close_check CHECK (close_status IN ('active', 'closure_pending', 'closed')),
  CONSTRAINT sales_special_stock_handoff_route_check CHECK (
    handoff_route IS NULL OR handoff_route IN ('none', 'direct', 'via_yard')
  ),
  CONSTRAINT sales_special_stock_completion_source_check CHECK (
    operational_completion_source IS NULL
    OR operational_completion_source IN ('vendor_pickup', 'dispatch_completion')
  ),
  CONSTRAINT sales_special_stock_vendor_pickup_evidence_check CHECK (
    operational_completion_source IS DISTINCT FROM 'vendor_pickup'
    OR (vendor_pickup_date IS NOT NULL AND NULLIF(btrim(vendor_pickup_reference), '') IS NOT NULL)
  ),
  CONSTRAINT sales_special_stock_remote_order_check CHECK (
    (sales_order_netsuite_id IS NULL) = (sales_order_ref IS NULL)
    AND (purchase_order_netsuite_id IS NULL) = (purchase_order_ref IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_special_stock_so_owner
  ON sales_special_stock_cases (sales_order_netsuite_id)
  WHERE sales_order_netsuite_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_special_stock_po_owner
  ON sales_special_stock_cases (purchase_order_netsuite_id)
  WHERE purchase_order_netsuite_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_special_stock_so_operation
  ON sales_special_stock_cases (sales_order_operation_id)
  WHERE sales_order_operation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_special_stock_po_operation
  ON sales_special_stock_cases (purchase_order_operation_id)
  WHERE purchase_order_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_case_queue
  ON sales_special_stock_cases (attention DESC, updated_at DESC, request_id DESC);

CREATE TABLE IF NOT EXISTS sales_special_stock_lines (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES sales_special_stock_cases(request_id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  brand text NOT NULL DEFAULT '',
  product_name text NOT NULL,
  color text NOT NULL DEFAULT '',
  size text NOT NULL DEFAULT '',
  requested_quantity numeric NOT NULL,
  requested_uom text NOT NULL,
  required_date date,
  estimate_line_reference text NOT NULL DEFAULT '',
  customer_note text NOT NULL DEFAULT '',
  supply_status text,
  availability_mode text,
  available_date date,
  response_vendor_id bigint,
  response_vendor_name text,
  vendor_yard text,
  vendor_reference text,
  sales_visible_note text NOT NULL DEFAULT '',
  scm_internal_note text NOT NULL DEFAULT '',
  unit_purchase_cost numeric,
  purchase_currency text,
  resolved_item_id bigint REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  resolved_item_name text,
  resolved_description text,
  sales_uom text,
  purchase_uom text,
  sales_quantity numeric,
  purchase_quantity numeric,
  pallet_quantity numeric,
  sales_decision text NOT NULL DEFAULT 'pending',
  sales_decision_reason text NOT NULL DEFAULT '',
  sales_customer_note text NOT NULL DEFAULT '',
  response_revision integer NOT NULL DEFAULT 0,
  decision_revision integer NOT NULL DEFAULT 0,
  responded_by text REFERENCES operators(id) ON DELETE SET NULL,
  responded_at timestamptz,
  decided_by text REFERENCES operators(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, line_number),
  CONSTRAINT sales_special_stock_line_number_check CHECK (line_number > 0 AND line_number <= 100),
  CONSTRAINT sales_special_stock_line_product_check CHECK (NULLIF(btrim(product_name), '') IS NOT NULL),
  CONSTRAINT sales_special_stock_line_quantity_check CHECK (
    requested_quantity > 0 AND requested_quantity <= 1000000000
    AND COALESCE(sales_quantity, 1) > 0
    AND COALESCE(purchase_quantity, 1) > 0
    AND COALESCE(pallet_quantity, 1) > 0
  ),
  CONSTRAINT sales_special_stock_line_supply_check CHECK (
    supply_status IS NULL
    OR supply_status IN ('in_stock', 'vendor_transfer', 'production', 'allocation', 'no_stock')
  ),
  CONSTRAINT sales_special_stock_line_availability_check CHECK (
    (availability_mode IS NULL AND available_date IS NULL)
    OR (availability_mode = 'dated' AND available_date IS NOT NULL)
    OR (availability_mode = 'no_projection' AND available_date IS NULL)
  ),
  CONSTRAINT sales_special_stock_line_decision_check CHECK (
    sales_decision IN ('pending', 'accepted', 'request_update', 'declined', 'closed')
  ),
  CONSTRAINT sales_special_stock_line_cost_check CHECK (unit_purchase_cost IS NULL OR unit_purchase_cost >= 0),
  CONSTRAINT sales_special_stock_line_revision_check CHECK (response_revision >= 0 AND decision_revision >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_lines_case
  ON sales_special_stock_lines (request_id, line_number);

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_lines_queue
  ON sales_special_stock_lines (sales_decision, supply_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS sales_special_stock_order_lines (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES sales_special_stock_cases(request_id) ON DELETE CASCADE,
  case_line_id bigint REFERENCES sales_special_stock_lines(id) ON DELETE RESTRICT,
  order_kind text NOT NULL,
  ancillary boolean NOT NULL DEFAULT false,
  item_id bigint NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  item_name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  quantity numeric NOT NULL,
  uom text,
  unit_rate numeric,
  unit_purchase_cost numeric,
  remote_line_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_special_stock_order_line_kind_check CHECK (order_kind IN ('sales_order', 'purchase_order')),
  CONSTRAINT sales_special_stock_order_line_quantity_check CHECK (quantity > 0 AND quantity <= 1000000000),
  CONSTRAINT sales_special_stock_order_line_case_check CHECK (
    (ancillary = true AND case_line_id IS NULL AND order_kind = 'sales_order')
    OR (ancillary = false AND case_line_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_special_stock_material_order_line
  ON sales_special_stock_order_lines (request_id, order_kind, case_line_id)
  WHERE case_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_order_lines_case
  ON sales_special_stock_order_lines (request_id, order_kind, id);

CREATE TABLE IF NOT EXISTS sales_special_stock_media (
  upload_id uuid PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES sales_special_stock_cases(request_id) ON DELETE CASCADE,
  object_ref text,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  status text NOT NULL DEFAULT 'issued',
  attached_sales_order_id bigint,
  created_by text NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  registered_at timestamptz,
  attached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_special_stock_media_mime_check CHECK (mime_type ~ '^(image|video)/'),
  CONSTRAINT sales_special_stock_media_size_check CHECK (byte_size > 0 AND byte_size <= 26214400),
  CONSTRAINT sales_special_stock_media_status_check CHECK (status IN ('issued', 'staged', 'attached', 'deleted')),
  CONSTRAINT sales_special_stock_media_object_check CHECK (
    (status = 'issued' AND object_ref IS NULL)
    OR (status <> 'issued' AND NULLIF(btrim(object_ref), '') IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_media_case
  ON sales_special_stock_media (request_id, status, created_at);

CREATE TABLE IF NOT EXISTS sales_special_stock_handoffs (
  request_id bigint PRIMARY KEY REFERENCES sales_special_stock_cases(request_id) ON DELETE CASCADE,
  route text,
  status text NOT NULL DEFAULT 'waiting_route',
  sales_order_netsuite_id bigint NOT NULL,
  purchase_order_netsuite_id bigint NOT NULL,
  pickup_address text NOT NULL,
  destination_address text NOT NULL,
  operational_yard_location_id bigint NOT NULL,
  line_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  route_selected_by text REFERENCES operators(id) ON DELETE SET NULL,
  route_selected_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_special_stock_handoff_route_check CHECK (route IS NULL OR route IN ('direct', 'via_yard')),
  CONSTRAINT sales_special_stock_handoff_status_check CHECK (
    status IN ('waiting_route', 'ready', 'planned', 'in_progress', 'completed', 'cancelled', 'attention')
  ),
  CONSTRAINT sales_special_stock_handoff_yard_check CHECK (operational_yard_location_id IN (1, 28, 15, 26)),
  CONSTRAINT sales_special_stock_handoff_snapshot_check CHECK (jsonb_typeof(line_snapshot) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_handoff_queue
  ON sales_special_stock_handoffs (status, updated_at DESC, request_id DESC);

CREATE TABLE IF NOT EXISTS sales_special_stock_events (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES sales_special_stock_cases(request_id) ON DELETE CASCADE,
  case_line_id bigint REFERENCES sales_special_stock_lines(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_id text REFERENCES operators(id) ON DELETE SET NULL,
  audience text NOT NULL DEFAULT 'all',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_special_stock_event_type_check CHECK (NULLIF(btrim(event_type), '') IS NOT NULL),
  CONSTRAINT sales_special_stock_event_audience_check CHECK (audience IN ('all', 'sales_scm', 'scm')),
  CONSTRAINT sales_special_stock_event_details_check CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_sales_special_stock_events_case
  ON sales_special_stock_events (request_id, created_at DESC, id DESC);

COMMENT ON TABLE sales_special_stock_cases IS
  'One-vendor, multi-line Special Item workflow linking one Sales Order and one exclusive Purchase Order.';

COMMENT ON COLUMN sales_special_stock_lines.unit_purchase_cost IS
  'SCM-only commercial data. Sales and Dispatch projections must remove this field.';

COMMENT ON TABLE sales_special_stock_events IS
  'Append-only workflow evidence; application code never updates or deletes event rows.';
