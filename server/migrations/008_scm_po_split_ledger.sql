CREATE TABLE IF NOT EXISTS dispatch_scm_po_splits (
  id bigserial PRIMARY KEY,
  source_po_id bigint REFERENCES purchase_orders(netsuite_id) ON DELETE CASCADE,
  source_po_ref text NOT NULL,
  split_po_id bigint REFERENCES purchase_orders(netsuite_id) ON DELETE CASCADE,
  split_po_ref text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS dispatch_scm_po_split_lines (
  id bigserial PRIMARY KEY,
  split_id bigint NOT NULL REFERENCES dispatch_scm_po_splits(id) ON DELETE CASCADE,
  source_line_id bigint REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  split_line_id bigint REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  item_id bigint,
  sku text,
  item_name text,
  pallet_qty numeric NOT NULL DEFAULT 0,
  layer_qty numeric NOT NULL DEFAULT 0,
  section_qty numeric NOT NULL DEFAULT 0,
  piece_qty numeric NOT NULL DEFAULT 0,
  sales_qty numeric NOT NULL DEFAULT 0,
  unit text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_po_splits_source
  ON dispatch_scm_po_splits(source_po_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_scm_po_split_lines_source
  ON dispatch_scm_po_split_lines(source_line_id);
