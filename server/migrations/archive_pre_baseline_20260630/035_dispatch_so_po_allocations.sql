CREATE TABLE IF NOT EXISTS dispatch_so_po_allocations (
  id bigserial PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES delivery_orders(netsuite_id) ON DELETE CASCADE,
  sales_order_ref text NOT NULL,
  sales_line_id bigint NOT NULL REFERENCES delivery_order_lines(id) ON DELETE CASCADE,
  po_order_id bigint NOT NULL REFERENCES receiving_orders(netsuite_id) ON DELETE CASCADE,
  po_order_ref text NOT NULL,
  po_line_id bigint NOT NULL REFERENCES receiving_order_lines(id) ON DELETE CASCADE,
  item_id bigint,
  item_name text,
  sku text,
  allocated_pallet_qty numeric NOT NULL DEFAULT 0,
  allocated_layer_qty numeric NOT NULL DEFAULT 0,
  allocated_section_qty numeric NOT NULL DEFAULT 0,
  allocated_piece_qty numeric NOT NULL DEFAULT 0,
  allocated_sales_qty numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by text,
  cancelled_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT dispatch_so_po_allocations_status_check CHECK (status IN ('active', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_so_po_allocations_so
  ON dispatch_so_po_allocations (sales_order_ref, status, sales_line_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_so_po_allocations_po
  ON dispatch_so_po_allocations (po_order_ref, status, po_line_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_so_po_allocations_item
  ON dispatch_so_po_allocations (item_id, status);
